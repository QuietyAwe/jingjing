// ============================================================
// 动态的「看过 / 提过」记录（灵光一闪加权与去重）
//
// - moments_seen：用户刚在动态页刷到的帖子，AI 更容易「突然想起」，只记最近一批
// - moment_recall_seen：已经被灵光一闪提过的片段，每条动态只走一次高概率通道
// ============================================================

import dayjs from "dayjs";
import { getMeta, setMeta } from "@/db/queries";

const META_KEY = "moments_seen";
/** 一分钟内的重复刷新不重复写库（动态页每次 load 都会调） */
const WRITE_INTERVAL_MS = 60 * 1000;
/** 只留最近这么多条 */
const MAX_IDS = 20;

let lastWriteAt = 0;

export interface MomentsSeen {
  at: string;
  ids: number[];
}

/** 记录用户在动态页看到的帖子（UI 加载/刷新时调用） */
export function markMomentsSeen(ids: number[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  if (now - lastWriteAt < WRITE_INTERVAL_MS) return;
  lastWriteAt = now;
  setMeta(
    META_KEY,
    JSON.stringify({ at: dayjs().toISOString(), ids: ids.slice(0, MAX_IDS) })
  );
}

/** 读取最近一次浏览记录；没有或格式坏了都当没有 */
export function getMomentsSeen(): MomentsSeen | null {
  const raw = getMeta(META_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at?: unknown; ids?: unknown };
    if (typeof parsed.at !== "string" || !Array.isArray(parsed.ids)) return null;
    const ids = parsed.ids.filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v)
    );
    return { at: parsed.at, ids };
  } catch {
    return null;
  }
}

// --- 灵光一闪去重：每条动态只被「近期动态」通道高概率提一次 ---

const RECALL_KEY = "moment_recall_seen";
/**
 * 提过就不再进高概率通道。
 *
 * 取值必须大于动态新近度窗口（6 小时），否则同一条帖子在窗口内会被反复提起，
 * 变成「只要最近发过动态，每轮都在灵光一闪」。24 小时留足余量，过期记录随之清掉。
 */
export const MOMENT_RECALL_DEDUP_HOURS = 24;

function parseRecall(raw: string | null): Record<string, string> {
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

/** 去重窗口内已经被灵光一闪提起过的片段 id */
export function getRecentlyRecalledFragmentIds(
  hours: number = MOMENT_RECALL_DEDUP_HOURS
): Set<number> {
  const cutoff = dayjs().subtract(hours, "hour");
  const out = new Set<number>();
  for (const [k, v] of Object.entries(parseRecall(getMeta(RECALL_KEY)))) {
    const id = Number(k);
    const at = dayjs(v);
    if (Number.isFinite(id) && at.isValid() && at.isAfter(cutoff)) out.add(id);
  }
  return out;
}

/** 记下「这条片段刚被提起过」，同时清掉过期记录 */
export function markMomentRecalled(fragmentId: number): void {
  const cutoff = dayjs().subtract(MOMENT_RECALL_DEDUP_HOURS, "hour");
  const record = parseRecall(getMeta(RECALL_KEY));
  for (const [k, v] of Object.entries(record)) {
    if (!dayjs(v).isAfter(cutoff)) delete record[k];
  }
  record[String(fragmentId)] = dayjs().toISOString();
  setMeta(RECALL_KEY, JSON.stringify(record));
}
