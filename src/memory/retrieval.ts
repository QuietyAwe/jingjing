// ============================================================
// P3-3: 本地检索 + 灵光一闪
// 流程: tokenize → LIKE 查询 Top3 → 刷新命中权重 → 衰减排序 → Top10 + 随机冷记忆
// ============================================================

import { tokenize } from "./tokenize";
import { calculateWeight, calculateWeights } from "./decay";
import {
  getDB,
} from "@/db/connection";
import {
  updateWeight,
  getEpiphanyRandom,
  getAllActive,
} from "@/db/queries";
import type { MemoryEvent } from "@/types/schema";

export interface RetrievalResult {
  /** Top N 命中事件（LIKE 匹配） */
  hitEvents: MemoryEvent[];
  /** Top 10 高权重活跃事件（衰减后排序） */
  topEvents: (MemoryEvent & { live_weight: number })[];
  /** 1 条随机冷记忆（灵光一闪） */
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

  // 5. 按实时权重排序取 Top 10
  withLiveWeight.sort((a, b) => b.live_weight - a.live_weight);
  const topEvents = withLiveWeight.slice(0, 10);

  // 6. 灵光一闪：随机抽 1 条低权重冷记忆
  const epiphany = getEpiphanyRandom();

  return { hitEvents, topEvents, epiphany, keywords };
}
