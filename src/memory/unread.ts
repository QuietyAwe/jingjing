// ============================================================
// 未读态：各入口的已读时刻
//
// 不建表、不加字段：已读时刻存 system_metadata，判据只看「最后一条时间 > 已读时刻」。
// ============================================================

import dayjs from "dayjs";
import { getDB } from "@/db/connection";
import { getMeta, setMeta } from "@/db/queries";

const MAIN_KEY = "seen_main_at";
const FRIENDS_KEY = "seen_friends_at";
const MOMENTS_KEY = "seen_moments_at";

/** 时间戳是否比已读时刻新（两侧都是 toISOString，可直接按字符串比较） */
export function isUnread(lastAt: string | null | undefined, seenAt: string | null): boolean {
  if (!lastAt) return false;
  if (!seenAt) return true;
  return lastAt > seenAt;
}

export function markMainSeen(at: string = dayjs().toISOString()): void {
  setMeta(MAIN_KEY, at);
}

export function getMainSeenAt(): string | null {
  return getMeta(MAIN_KEY);
}

function readFriendSeen(): Record<string, string> {
  const raw = getMeta(FRIENDS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function markFriendSeen(friendId: number, at: string = dayjs().toISOString()): void {
  const map = readFriendSeen();
  map[String(friendId)] = at;
  setMeta(FRIENDS_KEY, JSON.stringify(map));
}

export function getFriendSeenAt(friendId: number): string | null {
  return readFriendSeen()[String(friendId)] ?? null;
}

export function markMomentsSeenAt(at: string = dayjs().toISOString()): void {
  setMeta(MOMENTS_KEY, at);
}

export function getMomentsSeenAt(): string | null {
  return getMeta(MOMENTS_KEY);
}

/** 动态页是否有比上次浏览更新的帖子或评论 */
export function hasUnreadMoments(): boolean {
  const db = getDB();
  const m = db.getFirstSync<{ latest: string | null }>(
    "SELECT MAX(created_at) AS latest FROM moments"
  );
  const c = db.getFirstSync<{ latest: string | null }>(
    "SELECT MAX(created_at) AS latest FROM moment_comments"
  );
  const latest =
    [m?.latest, c?.latest]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .sort()
      .pop() ?? null;
  return isUnread(latest, getMomentsSeenAt());
}
