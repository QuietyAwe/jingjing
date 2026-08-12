// ============================================================
// P3-2: 艾宾浩斯衰减计算器
// 公式: W_now = max(1, floor(W_last * e^(-d * t_hours)))
// 优先级越高衰减越慢：priority 1-9 对应衰减系数按配置缩放
// ============================================================

import dayjs from "dayjs";
import { getWeightDecay } from "@/prompt/config";

const DEFAULT_BASE_RATE = 0.06;

/**
 * 根据优先级计算衰减系数
 * priority 1（琐事）→ 衰减快
 * priority 9（重大）→ 衰减慢
 * 基准系数由配置 ebbinghaus_decay_rate 控制（默认 0.06）
 */
function getDecayRate(priority: number): number {
  const baseRate = getWeightDecay().ebbinghaus_decay_rate || DEFAULT_BASE_RATE;
  // 以 baseRate 为中位数（priority 5），线性映射到 priority 1-9
  // priority 1 → baseRate * 2, priority 5 → baseRate, priority 9 → baseRate * 0.5
  const clamped = Math.max(1, Math.min(9, priority));
  const factor = 2 - (clamped - 1) * (1.5 / 8);
  return baseRate * factor;
}

/**
 * 计算当前权重（惰性求值，读取时计算）
 * @param lastWeight 最后一次访问时的权重
 * @param lastAccessed ISO8601 时间戳
 * @param priority 重要性权重 1-9（默认 5）
 * @returns 当前权重（1-100 整数）
 */
export function calculateWeight(
  lastWeight: number,
  lastAccessed: string,
  priority: number = 5
): number {
  const decayRate = getDecayRate(priority);
  const hoursDiff = dayjs().diff(dayjs(lastAccessed), "hour", true);
  const decayed = lastWeight * Math.exp(-decayRate * hoursDiff);
  return Math.max(1, Math.floor(decayed));
}

/**
 * 批量计算事件的实时权重
 * 返回新数组，不修改原事件对象
 */
export function calculateWeights<
  T extends { active_weight: number; last_accessed: string; priority: number }
>(events: T[]): (T & { live_weight: number })[] {
  return events.map((e) => ({
    ...e,
    live_weight: calculateWeight(e.active_weight, e.last_accessed, e.priority),
  }));
}
