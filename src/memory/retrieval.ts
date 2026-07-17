// ============================================================
// P3-3: 本地检索 + 灵光一闪
// 流程: tokenize → LIKE 查询 Top3 → 刷新命中权重 → 衰减排序 → TopN + 概率触发随机冷记忆
// ============================================================

import { tokenize } from "./tokenize";
import { calculateWeight, calculateWeights } from "./decay";
import { getDB } from "@/db/connection";
import { updateWeight, getEpiphanyRandom, getAllActive } from "@/db/queries";
import { getThresholds, getWeightDecay } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import type { MemoryEvent } from "@/types/schema";

export interface RetrievalResult {
  /** Top N 命中事件（LIKE 匹配） */
  hitEvents: MemoryEvent[];
  /** Top N 高权重活跃事件（衰减后排序，数量由 config 控制） */
  topEvents: (MemoryEvent & { live_weight: number })[];
  /** 1 条随机冷记忆（灵光一闪，概率触发） */
  epiphany: MemoryEvent | null;
  /** 提取的关键词 */
  keywords: string[];
}

/**
 * 完整本地检索流程 — 对齐 PRD 2.1 节第 2-5 步
 */
export function retrieve(userInput: string): RetrievalResult {
  // 1. 分词
  const keywords = tokenize(userInput, 3);

  // 2. SQL LIKE 查询 Top3 命中事件
  let hitEvents: MemoryEvent[] = [];
  if (keywords.length > 0) {
    const db = getDB();
    const conditions = keywords.map(() => "event_text LIKE ?").join(" OR ");
    const params = keywords.map((k) => `%${k}%`);
    hitEvents = db.getAllSync<MemoryEvent>(
      `SELECT * FROM memory_events WHERE is_archived = 0 AND (${conditions}) ORDER BY active_weight DESC LIMIT 3`,
      ...params
    );
  }

  // 3. 刷新命中事件权重为 100 + 更新 last_accessed
  for (const event of hitEvents) {
    updateWeight(event.id, 100);
  }

  // 4. 获取所有活跃事件，计算实时权重
  const allActive = getAllActive();
  const withLiveWeight = calculateWeights(allActive);

  // 5. 按实时权重排序取 Top N（数量由 config 驱动）
  const { context_active_events_limit } = getThresholds();
  withLiveWeight.sort((a, b) => b.live_weight - a.live_weight);
  const topEvents = withLiveWeight.slice(0, context_active_events_limit);

  // 6. 灵光一闪：概率触发，随机抽 1 条低权重冷记忆（排除 Top N 已选事件）
  const { epiphany_trigger_probability } = getWeightDecay();
  let epiphany: MemoryEvent | null = null;
  if (Math.random() < epiphany_trigger_probability) {
    const excludeIds = topEvents.map((e) => e.id);
    epiphany = getEpiphanyRandom(excludeIds);
  }

  logDebug("检索", `关键词: ${keywords.join(", ") || "无"}\n命中: ${hitEvents.length} 条\nTop${topEvents.length}: ${topEvents.map((e) => e.event_text.slice(0, 20)).join(" | ")}\n灵光一闪: ${epiphany ? epiphany.event_text.slice(0, 30) : "未触发"}`);

  return { hitEvents, topEvents, epiphany, keywords };
}
