// ============================================================
// P3-2: 艾宾浩斯衰减计算器
// 公式: W_now = max(1, floor(W_last * e^(-d * t_hours)))
// ============================================================

import dayjs from "dayjs";

const DEFAULT_DECAY_RATE = 0.06;

/**
 * 计算当前权重（惰性求值，读取时计算）
 * @param lastWeight 最后一次访问时的权重
 * @param lastAccessed ISO8601 时间戳
 * @param decayRate 衰减系数 d（默认 0.06）
 * @returns 当前权重（1-100 整数）
 */
export function calculateWeight(
  lastWeight: number,
  lastAccessed: string,
  decayRate: number = DEFAULT_DECAY_RATE
): number {
  const hoursDiff = dayjs().diff(dayjs(lastAccessed), "hour", true);
  const decayed = lastWeight * Math.exp(-decayRate * hoursDiff);
  return Math.max(1, Math.floor(decayed));
}

/**
 * 批量计算事件的实时权重
 * 返回新数组，不修改原事件对象
 */
export function calculateWeights<
  T extends { active_weight: number; last_accessed: string }
>(events: T[], decayRate: number = DEFAULT_DECAY_RATE): (T & { live_weight: number })[] {
  return events.map((e) => ({
    ...e,
    live_weight: calculateWeight(e.active_weight, e.last_accessed, decayRate),
  }));
}
