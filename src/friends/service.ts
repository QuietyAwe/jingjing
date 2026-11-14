// ============================================================
// 好友互动：评论 / 回评
//
// 沿用现有「概率 + 随机延迟 + 失败静默」范式：
// 真实的朋友大量动态下根本不评论，缺席也是真实感的一部分。
// 好友只看得到 feed（动态 + 已有评论），看不到主 AI 与用户的私聊。
// ============================================================

import { getDebutedFriends, getMomentById, getMomentComments, insertMomentComment, getUserInfo } from "@/db/queries";
import { generateFriendComment, generateFriendComments } from "@/llm/background";
import { getThresholds } from "@/prompt/config";
import { useSettingsStore } from "@/store/settingsStore";
import { logDebug } from "@/store/chatStore";
import { notifyMomentUpdates } from "@/moments/bus";
import { recordMomentExchangeMemory } from "@/moments/memory";
import { friendName } from "./persona";
import type { FriendPersona, MomentAuthor } from "@/types/schema";

/** 已排队的任务（评论 / 候选池生成），防同一互动重复触发 */
const pendingKeys = new Set<string>();

/** 同一条动态两次「候选池生成」的最小间隔：连发几条评论不该反复调模型 */
const POOL_COOLDOWN_MS = 2 * 60_000;
/** 每条动态上次开始筛候选池的时刻（冷却用） */
const poolStartedAt = new Map<number, number>();

/** 把作者渲染成 prompt 里的称呼（好友侧不认 [user] 占位符） */
function whoLabel(author: MomentAuthor, friendId?: number | null): string {
  if (author === "user") {
    return getUserInfo()?.basic_identity.nickname?.trim() || "用户";
  }
  if (author === "ai") {
    return useSettingsStore.getState().ai_name.trim() || "私藏";
  }
  return friendName(friendId) || "朋友";
}

/** 人性化随机延迟 */
function randomDelay(minMs: number, maxMs: number): number {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

/**
 * 用户/AI 发了动态后，掷骰决定「谁看到了这条动态」。
 *
 * 每位已登场好友**独立**掷一次骰：掷中的才进候选池（人设一起进提示词），
 * 由模型自己判断这些人里谁真的会开口——可以一个都不回。人数不设上限。
 */
export function maybeFriendCommentsOnMoment(momentId: number): void {
  const moment = getMomentById(momentId);
  // 好友之间的互相评论属于群聊，不做
  if (!moment || moment.author === "friend") return;

  const friends = getDebutedFriends();
  if (friends.length === 0) return;

  const comments = getMomentComments(momentId);
  const spokenIds = new Set(
    comments.filter((c) => c.author === "friend" && c.friend_id != null).map((c) => c.friend_id as number)
  );

  const { friend_comment_probability } = getThresholds();
  const candidates = friends.filter(
    (f) => !spokenIds.has(f.id) && Math.random() < friend_comment_probability
  );
  if (candidates.length === 0) {
    logDebug("动态", `动态 #${momentId} 没有朋友刷到（独立掷骰未命中）`);
    return;
  }

  const key = `pool:${momentId}`;
  if (pendingKeys.has(key)) return;
  if (Date.now() - (poolStartedAt.get(momentId) ?? 0) < POOL_COOLDOWN_MS) return;
  poolStartedAt.set(momentId, Date.now());
  pendingKeys.add(key);
  logDebug("动态", `动态 #${momentId} 有 ${candidates.length} 位朋友刷到：${candidates.map((f) => f.name).join("、")}`);

  // 刷到之后不会立刻留话：过一阵子才陆续出手
  setTimeout(() => {
    pendingKeys.delete(key);
    runFriendComments(momentId, candidates).catch((err) =>
      console.error("[friends] 评论异常:", err)
    );
  }, randomDelay(25_000, 5 * 60_000));
}

/**
 * 候选池 → 一次请求，让模型决定谁开口。
 * 拿到的留言逐条错开落库（评论区是陆续冒出来的）。
 */
async function runFriendComments(momentId: number, candidates: FriendPersona[]): Promise<void> {
  const moment = getMomentById(momentId);
  if (!moment) return;

  const comments = getMomentComments(momentId);
  const spokenIds = new Set(
    comments.filter((c) => c.author === "friend" && c.friend_id != null).map((c) => c.friend_id as number)
  );
  const alive = candidates.filter((f) => !spokenIds.has(f.id));
  if (alive.length === 0) return;

  const list = await generateFriendComments({
    preferences: useSettingsStore.getState().friend_preferences,
    moment: {
      authorLabel: whoLabel(moment.author, moment.friend_id),
      content: moment.content,
      mood: moment.mood,
    },
    comments: comments.slice(-4).map((c) => ({
      authorLabel: whoLabel(c.author, c.friend_id),
      content: c.content,
    })),
    candidates: alive.map((f) => ({ name: f.name, summary: f.summary, profile: f.profile })),
  });

  if (list.length === 0) {
    logDebug("动态", `没有人开口 #${momentId}（模型判断都不吭声）`);
    return;
  }

  list.forEach((item, index) => {
    const friend = alive.find((f) => f.name === item.name);
    if (!friend) return;
    // 每条错开几秒到几分钟，别一起冒出来
    const delay = 5_000 + Math.random() * 40_000 + index * (30_000 + Math.random() * 60_000);
    scheduleFriendComment(momentId, friend, item.content, delay);
  });
}

/**
 * 用户评论了好友的动态 → 这条动态的主人可能回一句（被动回复，不主动私信）。
 */
export function maybeFriendReplyToUser(momentId: number, replyTo: string): void {
  const moment = getMomentById(momentId);
  if (!moment || moment.author !== "friend" || moment.friend_id == null) return;

  const friend = getDebutedFriends().find((f) => f.id === moment.friend_id);
  if (!friend) return;

  const { friend_comment_probability } = getThresholds();
  if (Math.random() >= friend_comment_probability) return;

  // 已经在刷手机的人回评论更快
  scheduleComment(friend, momentId, randomDelay(6_000, 40_000), replyTo);
}

/** 排队一条好友评论（延迟后生成；同好友同动态防重） */
function scheduleComment(
  friend: FriendPersona,
  momentId: number,
  delayMs: number,
  replyTo: string | undefined
): void {
  const key = `${momentId}:${friend.id}:${replyTo ?? ""}`;
  if (pendingKeys.has(key)) return;
  pendingKeys.add(key);

  setTimeout(() => {
    pendingKeys.delete(key);
    runComment(friend, momentId, replyTo).catch((err) =>
      console.error("[friends] 评论异常:", err)
    );
  }, delayMs);
}

/**
 * 排一条「已经写好」的好友评论：AI 发帖时随帖子一次生成，只延迟落库。
 *
 * 先有内容、后按延迟出现——省掉一次额外请求，展示节奏仍然是陆续冒出来。
 */
export function scheduleFriendComment(
  momentId: number,
  friend: FriendPersona,
  content: string,
  delayMs: number
): void {
  const key = `preset:${momentId}:${friend.id}`;
  if (pendingKeys.has(key)) return;
  pendingKeys.add(key);

  setTimeout(() => {
    pendingKeys.delete(key);
    const moment = getMomentById(momentId);
    if (!moment) return;
    const spoken = getMomentComments(momentId).filter((c) => c.author === "friend");
    if (spoken.some((c) => c.friend_id === friend.id)) return;

    insertMomentComment(momentId, "friend", content, friend.id);
    logDebug("动态", `${friend.name} 评论动态 #${momentId}：${content.slice(0, 30)}`);
    notifyMomentUpdates();
    recordMomentExchangeMemory(momentId);
  }, delayMs);
}

/** 生成并落库一条好友评论；失败静默放弃 */
async function runComment(friend: FriendPersona, momentId: number, replyTo?: string): Promise<void> {
  const moment = getMomentById(momentId);
  if (!moment) return;

  const comments = getMomentComments(momentId);
  // 同一个人在同一条动态下只留一次话（回评不在此限：那是本人对用户的直接回应）
  if (!replyTo && comments.some((c) => c.author === "friend" && c.friend_id === friend.id)) return;

  const contextComments = replyTo
    ? comments.slice(-3)
    : comments.slice(-4);

  const text = await generateFriendComment({
    friendName: friend.name,
    profile: friend.profile,
    preferences: useSettingsStore.getState().friend_preferences,
    moment: {
      authorLabel: whoLabel(moment.author, moment.friend_id),
      content: moment.content,
      mood: moment.mood,
    },
    comments: contextComments.map((c) => ({
      authorLabel: whoLabel(c.author, c.friend_id),
      content: c.content,
    })),
  });

  if (!text) {
    logDebug("动态", `${friend.name} 评论生成失败，放弃: #${momentId}`);
    return;
  }

  insertMomentComment(momentId, "friend", text, friend.id);
  logDebug("动态", `${friend.name} 评论动态 #${momentId}：${text.slice(0, 30)}`);
  notifyMomentUpdates();
  // 互动片段追加到被评论帖子所属事件（按帖子作者归属）
  recordMomentExchangeMemory(momentId);
}
