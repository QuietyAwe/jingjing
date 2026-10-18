// ============================================================
// 好友花名册：生成、错峰登场、首秀前校正、重建/换人
//
// 生成只发生一次（幂等），之后稳定复用：熟人社会才有关系感。
// 用户看不到「系统刚造了几个朋友」，只会觉得这个人本来就有自己的圈子。
// ============================================================

import dayjs from "dayjs";
import { getDB } from "@/db/connection";
import {
  getAllFriends,
  hasFriendRoster,
  insertFriendPersona,
  setFriendActive,
  deactivateAllFriends,
  deleteAllFriends,
  getUserInfo,
  getMeta,
  setMeta,
} from "@/db/queries";
import { generateFriendRoster } from "@/llm/background";
import { hasApiKey } from "@/llm/client";
import { getPrompts, getThresholds } from "@/prompt/config";
import { getCurrentScene, formatScene } from "@/memory/scheduler";
import { stableHash } from "@/memory/dailyLife";
import { useSettingsStore } from "@/store/settingsStore";
import { useChatStore, logDebug } from "@/store/chatStore";

/** 首秀前偏好校正的重试间隔（失败不每次轮询都打一次请求） */
const RECALIBRATE_RETRY_MS = 10 * 60 * 1000;

/** 生成失败后的冷却：60s 轮询不该把失败的 LLM 请求打成连发 */
const FAIL_COOLDOWN_MS = 10 * 60 * 1000;

let generating: Promise<void> | null = null;
let recalibrateAttemptAt = 0;
let lastFailureAt = 0;

/**
 * 检查并生成好友花名册（幂等 + in-flight 护栏）
 * 触发点：首轮对话完成、动态引擎 60s 轮询（用户没走完一轮对话的兜底）
 */
export function checkAndGenerateFriends(): Promise<void> {
  if (generating) return generating;
  generating = doCheck().finally(() => {
    generating = null;
  });
  return generating;
}

async function doCheck(): Promise<void> {
  const prefs = useSettingsStore.getState().friend_preferences;

  // 首轮对话之前不生成：此刻还没有称呼、偏好、聊天痕迹，生成出来的人不贴。
  // 动态引擎的兜底是给「直接进动态页、不走聊天」的用户，至少得聊过一句。
  const hasChatHistory = useChatStore
    .getState()
    .messages.some((m) => !m.friend_id && m.role !== "system");
  if (!hasChatHistory && !hasFriendRoster()) return;

  if (!hasFriendRoster()) {
    if (Date.now() - lastFailureAt < FAIL_COOLDOWN_MS) return;
    await generateRoster(prefs);
    return;
  }

  await recalibrateBeforeDebut(prefs);
}

/**
 * 首秀前保存了偏好 → 静默重掷。
 * 此时好友还没被用户看见，重掷不产生任何关系损失，是最省心的路径。
 */
async function recalibrateBeforeDebut(prefs: string): Promise<void> {
  if (getMeta("friend_roster_prefs") === prefs) return;

  const now = dayjs();
  const all = getAllFriends().filter((f) => f.is_active === 1);
  if (all.length === 0) return;
  // 已经有人登场了：不再偷偷换人，交给设置页的「按偏好重建」
  if (all.some((f) => !f.debut_at || !dayjs(f.debut_at).isAfter(now))) return;

  if (Date.now() - recalibrateAttemptAt < RECALIBRATE_RETRY_MS) return;
  recalibrateAttemptAt = Date.now();

  logDebug("好友圈", "首秀前检测到偏好变化，按新偏好重掷花名册");
  deleteAllFriends();
  await generateRoster(prefs);
}

/**
 * 生成并落库一批好友；返回是否成功
 * @param countOverride 「换一个」只补一位，不能按整册人数生成
 */
async function generateRoster(prefs: string, countOverride?: number): Promise<boolean> {
  if (!hasApiKey()) return false;

  const { system_prompt } = getPrompts();
  if (!system_prompt.trim()) return false;

  const { friend_roster_size } = getThresholds();
  const size = countOverride ?? friend_roster_size;
  const count = Math.min(8, Math.max(1, Math.round(size) || 5));

  const scene = getCurrentScene();
  const info = getUserInfo();
  const userContext = info
    ? [
        info.basic_identity.nickname ? `称呼：${info.basic_identity.nickname}` : "",
        info.basic_identity.occupation ? `职业：${info.basic_identity.occupation}` : "",
        info.traits.length > 0 ? `特点：${info.traits.slice(-5).join("、")}` : "",
      ]
        .filter(Boolean)
        .join("；") || "（还不了解[user]）"
    : "（还不了解[user]）";

  const drafts = await generateFriendRoster({
    persona: system_prompt,
    scene: scene ? formatScene(scene) : "",
    userContext,
    preferences: prefs,
    count,
  });

  if (drafts.length === 0) {
    lastFailureAt = Date.now();
    logDebug("好友圈", "花名册生成失败（10 分钟内不再重试）");
    return false;
  }

  const existingNames = new Set(getAllFriends().map((f) => f.name));
  let index = 0;
  let inserted = 0;
  for (const d of drafts) {
    if (existingNames.has(d.name)) continue;
    insertFriendPersona({
      name: d.name,
      avatar_emoji: d.avatar_emoji,
      summary: d.summary,
      profile: d.profile,
      debut_at: debutAt(index, d.name),
    });
    index++;
    inserted++;
  }

  setMeta("friend_roster_prefs", prefs);
  logDebug(
    "好友圈",
    inserted > 0
      ? `花名册已生成 ${inserted} 位：${drafts.map((d) => d.name).join("、")}`
      : "花名册为空（生成内容不可用）"
  );
  return inserted > 0;
}

/**
 * 错峰登场：第一位今天、其余按天铺开，避免同一天冒出五个陌生人。
 * 当天时段已过就直接登场（用户晚上才打开 App 时不该再等一天）。
 */
function debutAt(index: number, name: string): string {
  const now = dayjs();
  if (index === 0) {
    const hour = 10 + (stableHash(`${name}#debut-hour`) % 9); // 10~18 点
    const at = now.hour(hour).minute(stableHash(`${name}#debut-min`) % 60).second(0);
    return (at.isAfter(now) ? at : now.add(10, "minute")).toISOString();
  }
  const day = now.add(index, "day");
  const hour = 9 + (stableHash(`${name}#debut-hour`) % 11);
  return day.hour(hour).minute(stableHash(`${name}#debut-min`) % 60).second(0).toISOString();
}

/**
 * 重建花名册（设置页，二次确认后调用）
 * 旧人全部停用而不是删除：认识过的人不会从记忆里格式化。
 */
export async function rebuildFriendRoster(): Promise<boolean> {
  deactivateAllFriends();
  const ok = await generateRoster(useSettingsStore.getState().friend_preferences);
  if (!ok) logDebug("好友圈", "重建失败，旧花名册保持停用状态");
  return ok;
}

/**
 * 换一个：只把这一位下线，补一位新人。
 * 不要求新人接替原关系定位——真实的人不是岗位。
 */
export async function replaceFriend(friendId: number): Promise<boolean> {
  setFriendActive(friendId, false);
  const prefs = useSettingsStore.getState().friend_preferences;
  const ok = await generateRoster(prefs, 1);
  if (!ok) return false;

  // generateRoster 会按默认错峰排登场；换人场景新人应立刻出现，不留空窗
  const fresh = getAllFriends().filter((f) => f.is_active === 1).pop();
  if (fresh) {
    getDB().runSync(
      "UPDATE friend_personas SET debut_at = ? WHERE id = ?",
      dayjs().toISOString(),
      fresh.id
    );
  }
  return true;
}
