// ============================================================
// 好友互动：评论 / 回评
//
// 沿用现有「概率 + 随机延迟 + 失败静默」范式：
// 真实的朋友大量动态下根本不评论，缺席也是真实感的一部分。
// 好友只看得到 feed（动态 + 已有评论），看不到主 AI 与用户的私聊。
// ============================================================

import { getDebutedFriends, getMomentById, getMomentComments, insertMomentComment, getUserInfo } from "@/db/queries";
import { generateFriendComment } from "@/llm/background";
import { getThresholds } from "@/prompt/config";
import { useSettingsStore } from "@/store/settingsStore";
import { logDebug } from "@/store/chatStore";
import { notifyMomentUpdates } from "@/moments/bus";
import { recordMomentExchangeMemory } from "@/moments/memory";
import { friendName } from "./persona";
import type { FriendPersona, Moment, MomentAuthor } from "@/types/schema";

/** 已排队的评论（momentId:friendId），防同一互动重复触发 */
const pendingKeys = new Set<string>();

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
 * 用户/AI 发了动态后，可能招来一位朋友的评论。
 * 每条动态最多一位朋友留话——多人同时起哄就成了群聊，会稀释主角。
 */
export function maybeFriendCommentsOnMoment(momentId: number): void {
  const moment = getMomentById(momentId);
  // 好友之间的互相评论属于群聊，不做
  if (!moment || moment.author === "friend") return;

  const comments = getMomentComments(momentId);
  if (comments.some((c) => c.author === "friend")) return;

  const friends = getDebutedFriends();
  if (friends.length === 0) return;

  const { friend_comment_probability } = getThresholds();
  if (Math.random() >= friend_comment_probability) {
    logDebug("动态", `好友没有评论动态 #${momentId}（概率未命中）`);
    return;
  }

  const friend = friends[Math.floor(Math.random() * friends.length)];
  scheduleComment(friend, momentId, randomDelay(25_000, 5 * 60_000), undefined);
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

/** 生成并落库一条好友评论；失败静默放弃 */
async function runComment(friend: FriendPersona, momentId: number, replyTo?: string): Promise<void> {
  const moment = getMomentById(momentId);
  if (!moment) return;

  const comments = getMomentComments(momentId);
  // 每条动态最多一位朋友留话（多人同时起哄就成了群聊，会稀释主角）；
  // 回评是本人对用户的直接回应，不受这个上限限制
  if (!replyTo && comments.some((c) => c.author === "friend")) return;

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
  // 涉及 user/ai 的互动才写记忆；好友单人动态本身不进记忆
  recordMomentExchangeMemory(momentId);
}
