// ============================================================
// P3-3: 本地检索 + 灵光一闪
// 流程: 分词 → 检索片段 → 关联事件 → 衰减排序 → TopN + 灵光一闪
// ============================================================

import { tokenize } from "./tokenize";
import { calculateWeight, calculateWeights } from "./decay";
import { getDB } from "@/db/connection";
import { updateWeight, getEpiphanyRandom, getAllActive, getFragmentsByEventId } from "@/db/queries";
import { getThresholds, getWeightDecay } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import type { MemoryEvent, MemoryFragment } from "@/types/schema";

export interface RetrievalResult {
  /** 命中事件（通过片段匹配关联） */
  hitEvents: MemoryEvent[];
  /** 命中事件的关联片段 */
  hitFragments: Map<number, MemoryFragment[]>;
  /** Top N 高权重活跃事件（衰减后排序，数量由 config 控制） */
  topEvents: (MemoryEvent & { live_weight: number })[];
  /** 1 条随机冷记忆（灵光一闪，概率触发） */
  epiphany: MemoryEvent | null;
  /** 提取的关键词 */
  keywords: string[];
}

/**
 * 完整本地检索流程
 *
 * 检索策略：只检索片段内容，通过片段关联事件
 * 片段长度 >= 10 字才参与检索
 */
export function retrieve(userInput: string): RetrievalResult {
  // 1. 分词
  const keywords = tokenize(userInput, 3);

  // 2. 通过片段内容匹配事件（片段长度 >= 10 字）
  let hitEvents: MemoryEvent[] = [];
  const hitEventIds = new Set<number>();
  if (keywords.length > 0) {
    const db = getDB();
    const conditions = keywords.map(() => "f.summary LIKE ?").join(" OR ");
    const params = keywords.map((k) => `%${k}%`);

    hitEvents = db.getAllSync<MemoryEvent>(
      `SELECT DISTINCT e.* FROM memory_events e
       INNER JOIN memory_fragments f ON e.id = f.event_index
       WHERE e.is_archived = 0
         AND LENGTH(f.summary) >= 10
         AND (${conditions})
       ORDER BY e.active_weight DESC
       LIMIT 3`,
      ...params
    );
    hitEvents.forEach((e) => hitEventIds.add(e.id));
  }

  // 3. 刷新命中事件权重为 100 + 更新 last_accessed + 获取关联片段
  const hitFragments = new Map<number, MemoryFragment[]>();
  for (const event of hitEvents) {
    updateWeight(event.id, 100);
    const fragments = getFragmentsByEventId(event.id);
    if (fragments.length > 0) {
      hitFragments.set(event.id, fragments);
    }
  }

  // 4. 获取所有活跃事件，按存储权重初筛后计算实时权重（减少计算量）
  const allActive = getAllActive();
  const { context_active_events_limit } = getThresholds();
  // 先按存储权重排序，取 2*N 候选，再计算实时权重精排
  const candidates = allActive
    .sort((a, b) => b.active_weight - a.active_weight)
    .slice(0, context_active_events_limit * 2);
  const withLiveWeight = calculateWeights(candidates);

  // 5. 按实时权重排序取 Top N（数量由 config 控制）
  withLiveWeight.sort((a, b) => b.live_weight - a.live_weight);
  const topEvents = withLiveWeight.slice(0, context_active_events_limit);

  // 6. 灵光一闪：概率触发，随机抽 1 条低权重冷记忆（排除 Top N 已选事件）
  const { epiphany_trigger_probability } = getWeightDecay();
  let epiphany: MemoryEvent | null = null;
  if (Math.random() < epiphany_trigger_probability) {
    const excludeIds = topEvents.map((e) => e.id);
    epiphany = getEpiphanyRandom(excludeIds);
  }

  logDebug("检索", `关键词: ${keywords.join(", ") || "无"}\n命中: ${hitEvents.length} 条事件 (${Array.from(hitFragments.values()).reduce((s, f) => s + f.length, 0)} 片段)\nTop${topEvents.length}: ${topEvents.map((e) => e.event_text.slice(0, 20)).join(" | ")}\n灵光一闪: ${epiphany ? epiphany.event_text.slice(0, 30) : "未触发"}`);

  return { hitEvents, hitFragments, topEvents, epiphany, keywords };
}
