// ============================================================
// 好友私聊：提示词拼装 + 弱痕迹
//
// 配角待遇：没有状态区/记忆区/灵光一闪/游戏区，
// 只有「她是谁」+ 最近的朋友圈 + 与用户的聊天记录。
//
// 信息隔离：好友私聊内容不进主 AI 记忆，
// 只在离开时留一条「聊过」的弱痕迹（知道有这回事，不知道内容）。
// ============================================================

import dayjs from "dayjs";
import {
  getMoments,
  getCommentsByMomentIds,
  getFragmentsMentioning,
  getUserInfo,
  getMeta,
  setMeta,
  insertEpisode,
} from "@/db/queries";
import { getThresholds } from "@/prompt/config";
import { replacePlaceholders } from "@/prompt/assembler";
import { useChatStore, logDebug } from "@/store/chatStore";
import { useSettingsStore } from "@/store/settingsStore";
import { friendName } from "./persona";
import type { FriendPersona } from "@/types/schema";

/** 同一好友的弱痕迹最多每 6 小时写一条 */
const TRACE_INTERVAL_HOURS = 6;

/** 好友固定格式的系统提示词：内容全部来自人物小传，用户不可编辑 */
export function buildFriendSystemPrompt(friend: FriendPersona): string {
  const info = getUserInfo();
  const nickname = info?.basic_identity.nickname?.trim() || "用户";
  const aiName = useSettingsStore.getState().ai_name.trim() || "私藏";

  const fill = (text: string) =>
    text.replace(/\[user\]/g, nickname).replace(/\[ai\]/g, aiName).replace(/\[time\]/g, "之前");

  const head = [
    `你是${friend.name}。`,
    "",
    fill(friend.profile),
    "",
    "[世界观边界] 你看不到他们俩的私聊内容；你在朋友圈能看到大家的动态与评论；你不知道自己是 AI 角色。",
    `[当前场景] 你正在和${nickname}一对一私聊（像微信那样），不是在朋友圈发动态。`,
    "[行为约束] 保持角色说话；不背诵任何设定；不主动结束话题；别长篇大论抢戏——话多话少由你的说话方式决定。",
  ].join("\n");

  // 可见的近期 feed
  const moments = getMoments(8).reverse();
  const commentMap = getCommentsByMomentIds(moments.map((m) => m.id));
  const feedLines: string[] = [];
  for (const m of moments) {
    const who =
      m.author === "friend" ? friendName(m.friend_id) : m.author === "ai" ? aiName : nickname;
    feedLines.push(`${who}（${m.mood || "未标"}）：${m.content}`);
    for (const c of (commentMap.get(m.id) ?? []).slice(-2)) {
      const cWho =
        c.author === "friend" ? friendName(c.friend_id) : c.author === "ai" ? aiName : nickname;
      feedLines.push(`  ${cWho}：${c.content}`);
    }
  }

  const parts = [head];
  if (feedLines.length > 0) {
    parts.push("", "## 你最近在朋友圈看到的", feedLines.join("\n"));
  }

  // 与该好友相关的记忆片段（限定，不注入完整用户画像）
  const fragments = getFragmentsMentioning(friend.name, 3);
  if (fragments.length > 0) {
    const lines = fragments.map((f) =>
      replacePlaceholders(f.gist || f.summary.slice(0, 24), f.timestamp, info, dayjs())
    );
    parts.push("", "## 你还记得的", lines.join("\n"));
  }

  parts.push("", `## 聊天对象`, `你正在和${nickname}聊天。`);
  return parts.join("\n");
}

/**
 * 构建好友私聊的消息数组。
 * 历史只取该好友线程（滑动窗口），不碰主聊天。
 */
export function buildFriendChatMessages(
  friend: FriendPersona,
  userInput: string
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const { context_history_rounds } = getThresholds();
  const window = context_history_rounds * 2;

  const history = useChatStore
    .getState()
    .messages.filter((m) => m.friend_id === friend.id && m.role !== "system")
    .slice(-window)
    .map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
    }));

  return [
    { role: "system", content: buildFriendSystemPrompt(friend) },
    ...history,
    { role: "user", content: userInput },
  ];
}

/**
 * 私聊结束后的弱痕迹：「聊过」这件事进主记忆，内容不进。
 *
 * 这是真实世界的信息传播路径之一——对象的朋友私下跟你说的话，
 * 你对象并不会自动知道，但会知道你们聊过。
 */
export function recordFriendChatTrace(friend: FriendPersona): void {
  const key = `friend_trace_${friend.id}`;
  const last = getMeta(key);
  if (last && dayjs().diff(dayjs(last), "hour") < TRACE_INTERVAL_HOURS) return;

  const userMessages = useChatStore
    .getState()
    .messages.filter((m) => m.friend_id === friend.id && m.role === "user");
  // 只发了「在吗」不算聊过，至少有一轮实质对话
  if (userMessages.length === 0) return;

  setMeta(key, dayjs().toISOString());
  insertEpisode(
    `和${friend.name}聊天`,
    `[time]和${friend.name}私下聊了会儿`,
    `[time][user]和${friend.name}私下聊了挺久，聊得挺投入。[ai]当时不在场，只后来知道有这么回事。`,
    4,
    `${friend.name},私聊,聊天`
  );
  logDebug("好友私聊", `已写入弱痕迹：和${friend.name}聊天`);
}
