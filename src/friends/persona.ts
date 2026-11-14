// ============================================================
// 好友档案的读取与按名字命中
//
// 这里只做「读 + 拼文本」，不调 LLM、不碰聊天状态。
// ============================================================

import dayjs from "dayjs";
import {
  getAllFriends,
  getDebutedFriends,
  getFriendById,
  getFragmentsMentioning,
} from "@/db/queries";
import type { FriendPersona, MemoryFragment } from "@/types/schema";

/** 已登场的好友（停用/未到登场时间的都不算）：feed 发帖与评论用 */
export function listDebutedFriends(now: dayjs.Dayjs = dayjs()): FriendPersona[] {
  return getDebutedFriends(now.toISOString());
}

/** 启用中的好友（含还没登场的）：按名字命中用 */
export function listActiveFriends(): FriendPersona[] {
  return getAllFriends().filter((f) => f.is_active === 1 && !f.is_deleted);
}

export function friendName(friendId?: number | null): string {
  if (friendId == null) return "";
  return getFriendById(friendId)?.name ?? "";
}

/** 按名字命中用的好友列表：长名优先，避免同名前缀误判 */
export function listNameMatchFriends(): FriendPersona[] {
  return listActiveFriends().sort((a, b) => b.name.length - a.name.length);
}

/** 文字里命中的好友；列表由调用方预取，避免逐行查库 */
export function matchFriendInText(text: string, friends: FriendPersona[]): FriendPersona | null {
  return friends.find((f) => f.name.length >= 2 && text.includes(f.name)) ?? null;
}

/**
 * 用户输入命中某位好友的名字 → 返回好友档案与最近 4 条相关记忆。
 *
 * 好友名不在 identityNames() 里，不会被检索误剥；bigram 召回也照常命中
 * 「上次小雨说的」。
 */
export function resolveFriendMention(
  userInput: string
): { friend: FriendPersona; fragments: MemoryFragment[] } | null {
  const hit = matchFriendInText(userInput.trim(), listNameMatchFriends());
  if (!hit) return null;

  return { friend: hit, fragments: getFragmentsMentioning(hit.name, 4) };
}

/** 私聊页/会话列表用的头像字（emoji 优先，没有就取名字首字） */
export function friendAvatarText(friend: FriendPersona): string {
  return friend.avatar_emoji?.trim() || friend.name.slice(0, 1);
}
