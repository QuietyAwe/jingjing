// ============================================================
// P3-2: 分层衰减计算器
//
// 模拟真实记忆的两类遗忘速度：
// - daily（日常琐事）：按小时衰减，几天内淡忘
// - episode（共同经历：游戏、深度对话）：按天衰减且有下限，
//   数月乃至数年后仍能停留在"可被偶然想起"的权重区间
// ============================================================

import dayjs from "dayjs";
import { getWeightDecay } from "@/prompt/config";
import type { MemoryKind } from "@/types/schema";

const DEFAULT_BASE_RATE = 0.06;

/** episode 记忆：每天衰减系数（约 0.06/天，一个月后权重落到下限附近） */
const EPISODE_DECAY_PER_DAY = 0.06;
/** episode 记忆的权重下限：永远不会被彻底遗忘，仍可被灵光一闪唤起 */
const EPISODE_MIN_WEIGHT = 15;

/**
 * 根据优先级计算日常记忆的衰减系数
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
 * @param kind 记忆类型（默认 daily）
 */
export function calculateWeight(
  lastWeight: number,
  lastAccessed: string,
  priority: number = 5,
  kind: MemoryKind = "daily"
): number {
  const now = dayjs();

  if (kind === "episode") {
    // 共同经历：以「天」为单位衰减，并保留下限
    const daysDiff = now.diff(dayjs(lastAccessed), "day", true);
    const decayed = lastWeight * Math.exp(-EPISODE_DECAY_PER_DAY * daysDiff);
    return Math.max(EPISODE_MIN_WEIGHT, Math.min(100, Math.floor(decayed)));
  }

  // 日常记忆：以「小时」为单位衰减
  const hoursDiff = now.diff(dayjs(lastAccessed), "hour", true);
  const decayRate = getDecayRate(priority);
  const decayed = lastWeight * Math.exp(-decayRate * hoursDiff);
  return Math.max(1, Math.floor(decayed));
}

/**
 * 批量计算事件的实时权重
 * 返回新数组，不修改原事件对象
 */
export function calculateWeights<
  T extends {
    active_weight: number;
    last_accessed: string;
    priority: number;
    memory_kind?: MemoryKind;
  }
>(events: T[]): (T & { live_weight: number })[] {
  return events.map((e) => ({
    ...e,
    live_weight: calculateWeight(
      e.active_weight,
      e.last_accessed,
      e.priority,
      e.memory_kind ?? "daily"
    ),
  }));
}

/** 细节可见阈值：权重低于此值时只记得"发生过"，细节已模糊 */
export const DETAIL_VISIBLE_WEIGHT = 40;
