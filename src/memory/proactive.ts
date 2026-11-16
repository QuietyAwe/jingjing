// ============================================================
// AI 主动开场：用户离开一段时间后，回来时由 AI 先开口
//
// 只在进入聊天页时判定（手机端没有可靠后台），一天最多一次。
// ============================================================

import dayjs from "dayjs";
import type { Dayjs } from "dayjs";
import { getMeta, setMeta } from "@/db/queries";
import type { ChatMessage } from "@/types/schema";

/** 距最后一条消息超过这么久，才值得由 AI 先开口 */
const GAP_HOURS = 3;
const META_KEY = "last_proactive_at";

/**
 * 是否该主动开场。
 *
 * 判据只看「对话状态」，不看内容：最后一句是 AI 说的、且已经过去足够久，
 * 说明用户离开了，此刻回来由 AI 接一句才自然。
 */
export function shouldOpenProactively(messages: ChatMessage[], now: Dayjs = dayjs()): boolean {
  const real = messages.filter(
    (m) => !m.friend_id && !m.is_state_note && m.role !== "system"
  );
  // 用户至少说过一句话：未自我介绍前由冷启动流程负责，不抢跑
  if (!real.some((m) => m.role === "user")) return false;

  const last = real[real.length - 1];
  // 最后一句是用户说的，说明还没回复完，不插话
  if (!last || last.role !== "assistant") return false;
  // 报错气泡不当作「AI 说完了」
  if (last.content.startsWith("⚠️")) return false;

  if (now.diff(dayjs(last.timestamp), "hour", true) < GAP_HOURS) return false;

  const done = getMeta(META_KEY);
  if (done && dayjs(done).isSame(now, "day")) return false;
  return true;
}

/** 记下今天已经主动开场过（失败也算，避免同一天反复重试） */
export function markProactiveDone(at: Dayjs = dayjs()): void {
  setMeta(META_KEY, at.toISOString());
}
