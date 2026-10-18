// ============================================================
// 好友档案的读取、花名册渲染、按名字命中
//
// 这里只做「读 + 拼文本」，不调 LLM、不碰 chatStore：
// prompt/assembler 会 import 本模块，反向依赖会成环。
// ============================================================

import dayjs from "dayjs";
import {
  getAllFriends,
  getDebutedFriends,
  getFriendById,
  getFriendLastInteraction,
  getFragmentsMentioning,
} from "@/db/queries";
import { getThresholds } from "@/prompt/config";
import type { FriendPersona, MemoryFragment } from "@/types/schema";

/** 已登场的好友（停用/未到登场时间的都不算）：feed、私聊入口用 */
export function listDebutedFriends(now: dayjs.Dayjs = dayjs()): FriendPersona[] {
  return getDebutedFriends(now.toISOString());
}

/**
 * 启用中的好友（含还没登场的）：状态区花名册与「按名字命中档案」用。
 * 先有花名册、后有 feed——AI 才能在聊天里自然提起一个过几天才出现的人。
 */
export function listActiveFriends(): FriendPersona[] {
  return getAllFriends().filter((f) => f.is_active === 1 && !f.is_deleted);
}

export function friendName(friendId?: number | null): string {
  if (friendId == null) return "";
  return getFriendById(friendId)?.name ?? "";
}

/**
 * 花名册行：只列最近有互动、或刚建立关系不久的人。
 * 半年不出现的人不该天天在 prompt 里站着。
 */
export function formatFriendRoster(now: dayjs.Dayjs = dayjs()): string {
  const friends = listActiveFriends();
  if (friends.length === 0) return "";

  const days = getThresholds().friend_roster_visible_days || 14;
  const cutoff = now.subtract(days, "day").valueOf();

  const visible = friends
    .map((f) => {
      const last = getFriendLastInteraction(f.id);
      const created = dayjs(f.created_at).valueOf();
      const lastTs = last ? dayjs(last).valueOf() : 0;
      return { f, lastTs, created };
    })
    .filter(({ lastTs, created }) => lastTs >= cutoff || created >= cutoff)
    .sort((a, b) => (b.lastTs || b.created) - (a.lastTs || a.created))
    .slice(0, 6);

  if (visible.length === 0) return "";
  return visible
    .map(({ f }) => (f.summary ? `${f.name}（${f.summary}）` : f.name))
    .join("、");
}

/**
 * 用户输入命中某位好友的名字 → 返回档案卡素材。
 *
 * 好友名不在 identityNames() 里，不会被检索误剥；bigram 召回也照常命中
 * 「上次小雨说的」。命中后用档案回答「她是谁」，用片段回答「她说过什么」。
 */
export function resolveFriendMention(
  userInput: string
): { friend: FriendPersona; fragments: MemoryFragment[] } | null {
  const text = userInput.trim();
  if (!text) return null;

  // 名字长的优先匹配，避免同名前缀误判
  const friends = listActiveFriends().sort((a, b) => b.name.length - a.name.length);
  const hit = friends.find((f) => f.name.length >= 2 && text.includes(f.name));
  if (!hit) return null;

  return { friend: hit, fragments: getFragmentsMentioning(hit.name, 4) };
}

/** 私聊页/会话列表用的头像字（emoji 优先，没有就取名字首字） */
export function friendAvatarText(friend: FriendPersona): string {
  return friend.avatar_emoji?.trim() || friend.name.slice(0, 1);
}
