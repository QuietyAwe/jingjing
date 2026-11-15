// ============================================================
// 心情动态发帖调度引擎（根布局挂载，60s 轮询）
//
// 真人感三层（发帖侧）：
// 1. 计划层——AI 的发帖计划随作息表生成；好友按天掷骰（当天定下、不再改）
// 2. 执行层——本时段内随机时刻触发 + 小概率临场放弃
// 3. 放弃层——错过时段不补发（置 skipped），LLM 失败保留待下轮重试
//
// 同时负责：每日实况生成（daily_log）、好友花名册的兜底生成
// ============================================================

import { useEffect } from "react";
import dayjs from "dayjs";
import {
  getMoments,
  getFragmentsByEventIds,
  getRecentSharedEvents,
  insertMoment,
  getPendingPlanForSlot,
  skipMissedPostPlans,
  updatePostPlanStatus,
  insertPostPlan,
  hasFriendPlanOnDay,
  getDebutedFriends,
  getFriendById,
  getUserInfo,
} from "@/db/queries";
import { anchorLine } from "@/prompt/assembler";
import type { FriendPersona, PostPlanItem } from "@/types/schema";
import { generateMoment, generateFriendMoment } from "@/llm/background";
import { getPrompts, getThresholds } from "@/prompt/config";
import {
  checkAndGenerateSchedule,
  getCurrentDayOfWeek,
  getCurrentScene,
  getCurrentTimeSlot,
  getWeekStart,
  formatScene,
} from "@/memory/scheduler";
import { ensureDailyLife, dayKey, stableHash } from "@/memory/dailyLife";
import { checkAndGenerateFriends } from "@/friends/roster";
import { friendName } from "@/friends/persona";
import { scheduleFriendComment } from "@/friends/service";
import { notifyMomentUpdates } from "@/moments/service";
import { recordAiMomentMemory, recordFriendMomentMemory } from "@/moments/memory";
import { logDebug } from "@/store/chatStore";
import { useSettingsStore } from "@/store/settingsStore";

/** 各时段的起止小时（与 scheduler 的时段编码一致） */
const SLOT_HOURS: Array<[number, number]> = [
  [6, 9],
  [9, 12],
  [12, 15],
  [15, 18],
  [18, 23],
];

/** 计划行 → 本时段内的随机触发时刻（首次见到时掷骰，之后稳定） */
const fireAtMap = new Map<number, number>();
/** 好友「想了想又没发」的概率：比 AI 更随性，做成固定值（不值得为它开一个设置项） */
const FRIEND_POST_SKIP_PROBABILITY = 0.15;
/** 发帖中（in-flight，防轮询重入） */
let posting = false;
let friendPosting = false;

/** 根布局挂载：全局发帖调度，与所在页面无关 */
export function useMomentsEngine(): void {
  useEffect(() => {
    let cancelled = false;
    // 一次 tick 可能串几次 LLM 调用（实况/花名册），60s 定时器会追上来；
    // 用一个简单的重入锁避免多轮并行
    let ticking = false;

    const tick = async () => {
      if (cancelled || ticking) return;
      ticking = true;
      try {
        // 幂等（in-flight 护栏 + 本周已有则跳过）；同时兜住周切换与从未进过聊天页的情况
        await checkAndGenerateSchedule();
        // 今天具体怎么过：一天一次，失败回退周基线
        await ensureDailyLife();
        // 好友花名册：没走过首轮对话也能有兜底入口
        await checkAndGenerateFriends();
        await checkAndPostDueMoments();
        await checkAndPostFriendMoments();
      } catch (err) {
        console.error("[moments] 调度异常:", err);
      } finally {
        ticking = false;
      }
    };

    tick();
    const timer = setInterval(tick, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
}

/** 距当前时段结束还有多少毫秒（<=0 表示时段尾巴已过） */
function slotRemainingMs(slot: number): number {
  const [, endHour] = SLOT_HOURS[slot];
  const end = dayjs().hour(endHour).minute(0).second(0).millisecond(0);
  return end.diff(dayjs());
}

/**
 * 检查并执行到期的发帖计划：
 * 先跳过已错过的（不补发），再对当前时段的待办掷骰（临场放弃 / 随机时刻触发）
 */
export async function checkAndPostDueMoments(): Promise<void> {
  const weekStart = getWeekStart();
  const day = getCurrentDayOfWeek();
  const slot = getCurrentTimeSlot(dayjs().hour());

  // 已错过的时段/日子：置 skipped，模仿真人「错过就算了」
  skipMissedPostPlans(weekStart, day, slot);
  if (slot < 0) return; // 深夜 0-6 点不发

  const due = getPendingPlanForSlot(weekStart, day, slot);
  if (due.length === 0) return;

  const now = Date.now();
  for (const plan of due) {
    let fireAt = fireAtMap.get(plan.id);
    if (fireAt === undefined) {
      const remaining = slotRemainingMs(slot);
      if (remaining <= 0) {
        updatePostPlanStatus(plan.id, "skipped");
        logDebug("动态", `发帖计划 #${plan.id} 错过时段，跳过`);
        continue;
      }
      // 临场放弃：想发又没发
      const skipProbability = getThresholds().moment_post_skip_probability;
      if (Math.random() < skipProbability) {
        updatePostPlanStatus(plan.id, "skipped");
        logDebug(
          "动态",
          `发帖计划 #${plan.id} 临场放弃：掷到 ${Math.round(skipProbability * 100)}% 的「想了想又没发」，不是失败`
        );
        continue;
      }
      fireAt = now + Math.random() * remaining;
      fireAtMap.set(plan.id, fireAt);
    }
    if (now < fireAt) continue;

    // 发布成功才清触发时刻：失败保留 pending 与 fireAt，下轮按原时刻继续重试，
    // 不再重掷「临场放弃」（想发的念头已经动过了，只是没发出去）
    if (await postFromPlan(plan)) {
      fireAtMap.delete(plan.id);
    }
  }
}

/**
 * 最近的共同经历：近 3 天最多 3 件，一件一行（标题 + 最新一句印象）
 *
 * 只给「发生了什么」，不给整段细节 —— 动态是随口一说，不是复盘。
 */
function recentMemoryLines(): string[] {
  const userInfo = getUserInfo();
  const events = getRecentSharedEvents(3, 3);
  if (events.length === 0) return [];
  const fragments = getFragmentsByEventIds(events.map((e) => e.id));
  return events.map((event) => {
    const title = anchorLine(event.event_text, event.timestamp, userInfo);
    const latest = fragments.get(event.id)?.slice(-1)[0];
    if (!latest) return title;
    const gist = anchorLine(latest.gist || latest.summary.slice(0, 24), latest.timestamp, userInfo);
    return gist === title ? title : `${title}｜${gist}`;
  });
}

/** 动态里的作者署名：提示词里必须出现真名，不能漏出 [user]/[ai] */
function momentAuthorLabel(author: string, friendId?: number | null): string {
  if (author === "friend") return friendName(friendId) || "朋友";
  if (author === "ai") return useSettingsStore.getState().ai_name.trim() || "私藏";
  return getUserInfo()?.basic_identity.nickname?.trim() || "用户";
}

/**
 * 每位已登场好友独立掷骰：掷中的才算「看到了这条动态」。
 * 掷中的人设会一起进提示词，由模型判断谁真的会开口（可以一个都不回）。
 */
function pickSeenFriends(): FriendPersona[] {
  const { friend_comment_probability } = getThresholds();
  return getDebutedFriends().filter(() => Math.random() < friend_comment_probability);
}

/**
 * 随帖子一起生成的好友留言：按名字找人，错开延迟落库。
 * 内容已经写好了，延迟只决定「什么时候出现在评论区」。
 */
function schedulePresetComments(
  momentId: number,
  comments: Array<{ name: string; content: string }>
): void {
  if (comments.length === 0) return;
  const friends = getDebutedFriends();
  comments.forEach((comment, index) => {
    const friend = friends.find((f) => f.name === comment.name);
    if (!friend) return;
    // 第一条 20s~2min，后面每条再往后推 1~3min
    const delay = 20_000 + Math.random() * 100_000 + index * (60_000 + Math.random() * 120_000);
    scheduleFriendComment(momentId, friend, comment.content, Math.round(delay));
  });
}

/** 按计划行生成并发布一条 AI 动态；返回是否已处理完（失败保留 pending 下轮重试） */
async function postFromPlan(plan: PostPlanItem): Promise<boolean> {
  if (posting) return false;
  posting = true;
  try {
    const { system_prompt } = getPrompts();
    const scene = getCurrentScene();
    // 最近动态取 5 条，时间升序，帮 LLM 避免重复、保持连贯
    const recent = getMoments(5).reverse();

    const draft = await generateMoment(system_prompt, {
      scene: scene ? formatScene(scene) : "",
      themeHint: plan.theme_hint,
      memories: recentMemoryLines(),
      // 掷骰筛出的「看到了这条动态的人」：评论区只能来自这些名字，人设一起给模型
      friends: pickSeenFriends().map((f) => ({
        name: f.name,
        summary: f.summary,
        profile: f.profile,
      })),
      recentMoments: recent.map((m) => ({
        author: m.author,
        content: m.content,
        mood: m.mood,
        authorLabel: momentAuthorLabel(m.author, m.friend_id),
      })),
    });

    if (!draft) {
      // 保留 pending：下轮继续重试（时段结束仍未成功会被置 skipped）
      logDebug("动态", `发帖生成失败，保留待下轮重试: 计划 #${plan.id}`);
      return false;
    }

    const momentId = insertMoment("ai", draft.content, draft.mood);
    updatePostPlanStatus(plan.id, "posted");
    logDebug("动态", `AI 发布动态（${draft.mood}）：${draft.content.slice(0, 30)}`);
    notifyMomentUpdates();
    // AI 自身动态存档进记忆，供检索时自我引用
    recordAiMomentMemory(momentId);
    // 随帖子一起生成的好友留言：错开延迟落库，看起来是陆续冒出来的
    schedulePresetComments(momentId, draft.friendComments);
    return true;
  } finally {
    posting = false;
  }
}

// ============================================================
// 好友发帖
// ============================================================

/**
 * 为今天补齐好友的发帖计划。
 *
 * 每位好友每天只掷一次骰（确定性哈希：同一天多次轮询结果一致、重启也不会重复），
 * 掷中就插一条 pending 计划，交给执行层按时段随机触发；掷不中就是今天不发。
 */
function ensureFriendPlansForToday(
  weekStart: string,
  dayOfWeek: number,
  currentSlot: number
): void {
  const friends = getDebutedFriends();
  if (friends.length === 0) return;

  const { friend_moment_probability } = getThresholds();
  const today = dayKey();

  for (const friend of friends) {
    if (hasFriendPlanOnDay(weekStart, dayOfWeek, friend.id)) continue;

    const roll = (stableHash(`${friend.id}#${today}#post`) % 1000) / 1000;
    if (roll >= friend_moment_probability) continue;

    // 1=上午 2=午 3=下午 4=晚（早间与深夜不发，和 AI 的节奏一致）
    const rolled = 1 + (stableHash(`${friend.id}#${today}#slot`) % 4);
    // 掷到今天已经过去的时段：顺延到当前时段——刚落库就被置 skipped，
    // 会让刚登场的人第一天完全不发声
    const slot = Math.max(rolled, currentSlot);
    insertPostPlan(weekStart, [
      {
        day_of_week: dayOfWeek,
        time_slot: slot,
        theme_hint: "",
        author: "friend",
        friend_id: friend.id,
      },
    ]);
    logDebug("动态", `${friend.name} 今天想发条动态（计划 #${dayOfWeek}/${slot}）`);
  }
}

/** 检查并执行好友的到期发帖计划 */
export async function checkAndPostFriendMoments(): Promise<void> {
  const weekStart = getWeekStart();
  const day = getCurrentDayOfWeek();
  const slot = getCurrentTimeSlot(dayjs().hour());
  if (slot < 0) return;

  ensureFriendPlansForToday(weekStart, day, slot);

  const due = getPendingPlanForSlot(weekStart, day, slot, "friend");
  if (due.length === 0) return;

  const now = Date.now();
  for (const plan of due) {
    let fireAt = fireAtMap.get(plan.id);
    if (fireAt === undefined) {
      const remaining = slotRemainingMs(slot);
      if (remaining <= 0) {
        updatePostPlanStatus(plan.id, "skipped");
        logDebug("动态", `好友发帖计划 #${plan.id} 错过时段，跳过`);
        continue;
      }
      // 好友也会「想了想又没发」，比 AI 更随性一点
      if (Math.random() < FRIEND_POST_SKIP_PROBABILITY) {
        updatePostPlanStatus(plan.id, "skipped");
        logDebug(
          "动态",
          `好友发帖计划 #${plan.id} 临场放弃：掷到 ${Math.round(FRIEND_POST_SKIP_PROBABILITY * 100)}% 的「想了想又没发」，不是失败`
        );
        continue;
      }
      fireAt = now + Math.random() * remaining;
      fireAtMap.set(plan.id, fireAt);
    }
    if (now < fireAt) continue;

    if (await postFriendFromPlan(plan)) {
      fireAtMap.delete(plan.id);
    }
  }
}

/** 按计划行发布一条好友动态；发帖后写一条「朋友圈日常」记忆 */
async function postFriendFromPlan(plan: PostPlanItem): Promise<boolean> {
  if (friendPosting) return false;
  friendPosting = true;
  try {
    const friend = plan.friend_id != null ? getFriendById(plan.friend_id) : null;
    if (!friend || friend.is_active !== 1) {
      updatePostPlanStatus(plan.id, "skipped");
      return true;
    }

    const recent = getMoments(5).reverse();
    // 好友侧不认 [user] 占位符，直接用真名
    const nickname = getUserInfo()?.basic_identity.nickname?.trim() || "用户";
    const aiName = useSettingsStore.getState().ai_name.trim() || "私藏";

    const draft = await generateFriendMoment({
      friendName: friend.name,
      profile: friend.profile,
      // 不要传主角的作息：好友有自己的日子（写在小传里），
      // 传过去会让「你现在」变成主角的下午
      scene: "",
      recent: recent.map((m) => ({
        author: m.author,
        content: m.content,
        mood: m.mood,
        authorLabel:
          m.author === "friend" ? friendName(m.friend_id) : m.author === "ai" ? aiName : nickname,
      })),
    });

    if (!draft) {
      logDebug("动态", `${friend.name} 发帖生成失败，保留待下轮重试: 计划 #${plan.id}`);
      return false;
    }

    const momentId = insertMoment("friend", draft.content, draft.mood, friend.id);
    updatePostPlanStatus(plan.id, "posted");
    logDebug("动态", `${friend.name} 发布动态（${draft.mood}）：${draft.content.slice(0, 30)}`);
    notifyMomentUpdates();
    // 进「朋友圈日常」：AI 之后能记得朋友刷过什么
    recordFriendMomentMemory(momentId);
    return true;
  } finally {
    friendPosting = false;
  }
}
