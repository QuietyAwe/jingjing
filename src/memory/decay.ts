// ============================================================
// P3-2: 分层衰减计算器
//
// 遗忘速度只看优先级，记忆类型不参与；所有档位都随基准 ebbinghaus_decay_rate 等比缩放：
// - 6 级在基准 0.02 下跌到遗忘线（15 分）需要 20 天
// - 每差一级，速度快/慢 1.88 倍（3 级约 3 天、9 级约 133 天）
// - 7 级及以上保留 15 分下限，永不彻底遗忘
// ============================================================

import dayjs from "dayjs";
import { getWeightDecay } from "@/prompt/config";

/** 配置里 ebbinghaus_decay_rate 的默认值；它翻倍，所有档位的衰减速度都翻倍 */
const REFERENCE_BASE_RATE = 0.02;

/** 重要记忆的权重下限：永远不会被彻底遗忘，仍可被灵光一闪唤起 */
const IMPORTANT_MIN_WEIGHT = 15;
/** 达到这个优先级才享受 15 分下限 */
const IMPORTANT_MIN_PRIORITY = 7;

/** 权重从满分跌到遗忘线所需的衰减量 */
const DECAY_TO_FORGET = Math.log(100 / IMPORTANT_MIN_WEIGHT);

/** 锚点：6 级在参考基准下跌到遗忘线的天数 */
const ANCHOR_DAYS = 20;
/** 锚点对应的优先级 */
const ANCHOR_PRIORITY = 6;
/** 每差一级，衰减速度相差的倍数（由「3 级约 3 天、6 级约 20 天」倒推） */
const PRIORITY_STEP = 1.88;

/** 某优先级下一小时的衰减系数：天数越小衰减越快，基准放大时整体加快 */
function decayRatePerHour(priority: number): number {
  const base = getWeightDecay().ebbinghaus_decay_rate || REFERENCE_BASE_RATE;
  const days =
    ANCHOR_DAYS *
    Math.pow(PRIORITY_STEP, priority - ANCHOR_PRIORITY) *
    (REFERENCE_BASE_RATE / base);
  return DECAY_TO_FORGET / days / 24;
}

/**
 * 计算当前权重（惰性求值，读取时计算）
 * @param lastWeight 最后一次访问时的权重
 * @param lastAccessed ISO8601 时间戳
 * @param priority 重要性 1-9（默认 5）
 */
export function calculateWeight(
  lastWeight: number,
  lastAccessed: string,
  priority: number = 5
): number {
  const p = Math.max(1, Math.min(9, priority));
  const hoursDiff = dayjs().diff(dayjs(lastAccessed), "hour", true);
  const decayed = lastWeight * Math.exp(-decayRatePerHour(p) * hoursDiff);
  // 7 级以上永不彻底遗忘；其余可以一路跌到 1
  const floor = p >= IMPORTANT_MIN_PRIORITY ? IMPORTANT_MIN_WEIGHT : 1;
  return Math.max(floor, Math.min(100, Math.floor(decayed)));
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
  }
>(events: T[]): (T & { live_weight: number })[] {
  return events.map((e) => ({
    ...e,
    live_weight: calculateWeight(e.active_weight, e.last_accessed, e.priority),
  }));
}

/**
 * 细节可见阈值（默认值，可在设置「记忆流转阈值」覆盖）：权重低于此值时只注入一句话 gist。
 *
 * 只在兜底路径（AI 检索判定不可用）参与详略；主路径按判定档位与指认的片段决定。
 * 取 60：priority 6 约 5.4 天跌到该线以下开始「只剩一句话」。
 */
export const DETAIL_VISIBLE_WEIGHT = 60;

/**
 * 冷记忆上限：权重低于此值才算「冷」，可被灵光一闪随机唤起。
 * 与详细/简略阈值解耦（那边调高不会把温记忆也抽成灵光一闪），保持 40 的冷记忆池语义。
 */
export const COLD_MEMORY_MAX_WEIGHT = 40;
