// ============================================================
// P3-3: 本地检索 + 灵光一闪
// 流程: 分词 → 检索事件 → 未命中则检索片段 → 衰减排序 → TopN + 灵光一闪
// ============================================================

import { tokenize, scoreOverlap } from "./tokenize";
import { blockedWords, isBlockedGram } from "./identity";
import { calculateWeight, calculateWeights, COLD_MEMORY_MAX_WEIGHT } from "./decay";
import { getDB } from "@/db/connection";
import { updateWeight, getAllActive, getFragmentsByEventId, getFragmentsByEventIds, getDefaultEventId } from "@/db/queries";
import { EVENT_COLUMNS } from "@/db/schema";
import { getThresholds, getWeightDecay } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import type { MemoryEvent, MemoryFragment } from "@/types/schema";

export interface RetrievalResult {
  /** 命中事件（通过片段匹配关联） */
  hitEvents: MemoryEvent[];
  /** 命中事件的关联片段 */
  hitFragments: Map<number, MemoryFragment[]>;
  /** 被当前输入真正唤起的片段 id（内容与话题有实质重合）——只有它们回到「记得很清楚」，其余片段照常随年龄变模糊 */
  cuedFragmentIds: Set<number>;
  /** 注入记忆区的事件（命中事件在前，再补高权重的「氛围记忆」），按实时权重排序 */
  topEvents: (MemoryEvent & { live_weight: number })[];
  /** 1 条冷记忆（灵光一闪，概率触发），带一句 gist 好让 AI 有话可说 */
  epiphany: (MemoryEvent & { gist: string }) | null;
  /** 提取的关键词 */
  keywords: string[];
}

/**
 * 按「关键词重合度」给候选事件排序
 *
 * SQL 侧只做粗召回（OR 匹配），真正的排序在这里做：
 * 重合数多的排在前面，同分时再用存储权重（= 最近是否被想起过）兜底。
 * @param pick 从候选里取出用于打分的文本
 */
function rankByOverlap<T extends { active_weight: number }>(
  candidates: T[],
  pick: (item: T) => string,
  keywords: string[]
): T[] {
  return candidates
    .map((item) => ({ item, score: scoreOverlap(pick(item), keywords) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.item.active_weight - a.item.active_weight)
    .map((x) => x.item);
}

/**
 * 完整本地检索流程
 *
 * 检索策略：优先检索事件(event_text)，未命中再检索片段(gist + summary)
 * 命中事件时直接返回关联片段，无需额外检索
 */
export function retrieve(userInput: string): RetrievalResult {
  // 1. 分词（bigram，见 tokenize.ts 的说明）
  // 屏蔽词（默认是身份名：用户昵称 / AI 名称，可在「检索屏蔽词」设置里自定义高频词）
  // 不当检索词：几乎每条记忆都带名字，输入里一提名字就会把一堆无关记忆误命中
  const blocked = blockedWords();
  const keywords = tokenize(userInput, 16, (g) => isBlockedGram(g, blocked));

  // 2. 优先检索事件(event_text)，排除默认事件"日常闲聊"
  let hitEvents: MemoryEvent[] = [];
  const hitEventIds = new Set<number>();
  const db = getDB();
  const defaultEventId = getDefaultEventId();

  if (keywords.length > 0) {
    const eventConditions = keywords.map(() => "event_text LIKE ?").join(" OR ");
    const excludeDefault = defaultEventId ? `AND id != ${defaultEventId}` : "";
    const params = keywords.map((k) => `%${k}%`);

    // 多取一些候选，再用「命中了几个关键词」精排——bigram 必然带噪音，不能命中即算数
    const candidates = db.getAllSync<MemoryEvent>(
      `SELECT ${EVENT_COLUMNS} FROM memory_events
       WHERE 1 = 1 ${excludeDefault} AND (${eventConditions})
       ORDER BY active_weight DESC
       LIMIT 10`,
      ...params
    );
    hitEvents = rankByOverlap(candidates, (e) => e.event_text, keywords).slice(0, 3);
    hitEvents.forEach((e) => hitEventIds.add(e.id));
  }

  // 3. 如果事件未命中，再检索片段(gist + summary)，同样排除默认事件
  if (hitEvents.length === 0 && keywords.length > 0) {
    // keywords 一并参与：LLM 写入时抽的关键词（含同义说法）能把「我妈」和「妈妈」连上
    const fragConditions = keywords
      .map(() => "(f.summary LIKE ? OR f.gist LIKE ? OR f.keywords LIKE ?)")
      .join(" OR ");
    const excludeDefault = defaultEventId ? `AND e.id != ${defaultEventId}` : "";
    const params = keywords.flatMap((k) => [`%${k}%`, `%${k}%`, `%${k}%`]);

    const rows = db.getAllSync<MemoryEvent>(
      `SELECT DISTINCT ${EVENT_COLUMNS.split(", ")
        .map((c) => `e.${c}`)
        .join(", ")} FROM memory_events e
       INNER JOIN memory_fragments f ON e.id = f."index"
       WHERE 1 = 1 ${excludeDefault}
         AND LENGTH(f.summary) >= 10
         AND (${fragConditions})
       ORDER BY e.active_weight DESC
       LIMIT 10`,
      ...params
    );
    // 片段打分：把该事件所有片段拼起来算总重合度（任一条片段对得上就可能唤起整段经历）
    const frags = getFragmentsByEventIds(rows.map((e) => e.id));
    hitEvents = rankByOverlap(
      rows,
      (e) =>
        (frags.get(e.id) ?? [])
          .map((f) => `${f.gist} ${f.summary} ${f.keywords}`)
          .join(" "),
      keywords
    ).slice(0, 3);
    hitEvents.forEach((e) => hitEventIds.add(e.id));
  }

  // 4. 刷新命中事件权重为 100 + 更新 last_accessed + 批量获取关联片段
  const hitFragments = new Map<number, MemoryFragment[]>();
  if (hitEvents.length > 0) {
    for (const event of hitEvents) {
      updateWeight(event.id, 100);
    }
    const fetched = getFragmentsByEventIds(hitEvents.map((e) => e.id));
    for (const [eventId, fragments] of fetched) {
      if (fragments.length > 0) hitFragments.set(eventId, fragments);
    }
  }

  // 5. 实时权重排序取 Top N（数量由 config 控制）
  //
  // 注意：不能用 active_weight 做预筛——该列在建事件与命中时都被写成 100，
  // 全仓没有任何一处把它写低，按它排序等于不排序，候选集退化成「最早创建的事件」，
  // 事件数超过候选上限后新记忆就再也进不了记忆区。
  // 实时权重只依赖 last_accessed / priority，直接全量计算即可（本地数据量级可忽略）。
  const allActive = getAllActive();
  const { context_active_events_limit } = getThresholds();
  const withLiveWeight = calculateWeights(allActive).sort(
    (a, b) => b.live_weight - a.live_weight
  );
  const hitIdSet = new Set(hitEvents.map((e) => e.id));
  // 记忆区顺序：**检索命中的放前面**（和当前话题相关），再补几条高权重的「氛围记忆」。
  // 氛围记忆限量，免得把无关记忆灌满上下文、冲淡真正相关的内容
  const AMBIENT_LIMIT = 5;
  const ambient = withLiveWeight
    .filter((e) => !hitIdSet.has(e.id))
    .slice(0, Math.max(0, Math.min(context_active_events_limit, AMBIENT_LIMIT)));
  // updateWeight 刚把命中事件刷成 100/now，但 hitEvents 是刷新前 SELECT 出的旧对象，
  // 继续用 e.last_accessed 会把「刚被想起」算成低权重：截断时命中记忆反而最先被丢
  const hitAt = new Date().toISOString();
  const hitWeighted = hitEvents.map((e) => ({
    ...e,
    active_weight: 100,
    last_accessed: hitAt,
    live_weight: calculateWeight(100, hitAt, e.priority, e.memory_kind),
  }));
  const topEvents = [...hitWeighted, ...ambient].slice(0, context_active_events_limit);

  // 6. 灵光一闪：概率触发，从「当前实时权重低的冷记忆」里随机抽 1 条
  // （原来在 SQL 里筛 active_weight < 40，该列恒为 100，所以这条链路从来没触发过）
  const { epiphany_trigger_probability } = getWeightDecay();
  let epiphany: (MemoryEvent & { gist: string }) | null = null;
  if (Math.random() < epiphany_trigger_probability) {
    const topIds = new Set(topEvents.map((e) => e.id));
    const cold = withLiveWeight.filter(
      (e) => e.live_weight < COLD_MEMORY_MAX_WEIGHT && !topIds.has(e.id)
    );
    if (cold.length > 0) {
      // 优先挑「和当前输入有弱关联」的冷记忆——真实的突然想起是被什么触发的，不是掷骰子
      const scored = cold
        .map((e) => ({ e, s: scoreOverlap(e.event_text, keywords) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      const pool = scored.length > 0 ? scored.slice(0, 3).map((x) => x.e) : cold;
      const picked = pool[Math.floor(Math.random() * pool.length)];
      // 注入一句话印象，否则 AI 只拿到事件标题、根本没法接话
      const gist =
        getFragmentsByEventId(picked.id).slice(-1)[0]?.gist || picked.event_text;
      epiphany = { ...picked, gist };
    }
  }

  // 8. 无强关联时，补充最近的"日常闲聊"片段到 topEvents
  if (hitEvents.length === 0 && defaultEventId) {
    const chatFragments = getFragmentsByEventId(defaultEventId);
    if (chatFragments.length > 0) {
      // 取最近 3 条闲聊片段
      const recentChats = chatFragments.slice(-3);
      hitFragments.set(defaultEventId, recentChats);
      // 把日常闲聊事件加入 topEvents（这样会被渲染到记忆区）
      const defaultEvent = db.getFirstSync<MemoryEvent>(
        `SELECT ${EVENT_COLUMNS} FROM memory_events WHERE id = ?`,
        defaultEventId
      );
      if (defaultEvent) {
        const live_weight = calculateWeight(defaultEvent.active_weight, defaultEvent.last_accessed, defaultEvent.priority);
        topEvents.unshift({ ...defaultEvent, live_weight });
      }
    }
  }

  // 9. 计算「被唤起的片段」：内容与当前输入有实质重合的片段才算刚想起来
  //
  // 像人的想起只增强被唤起的那条细节，不会把整段往事全部擦亮。
  // 判定：≥2 个不同关键词命中，或输入很短（≤2 个关键词）时 ≥1 即算——
  // 后者让「吃面」这类单词cue 能唤起对应细节，前者把「今天天气真好」
  // 只撞上一个「今天」bigram 的噪音挡在外面。
  const cuedFragmentIds = new Set<number>();
  if (keywords.length > 0) {
    for (const frags of hitFragments.values()) {
      for (const f of frags) {
        const s = scoreOverlap(`${f.gist} ${f.summary} ${f.keywords}`, keywords);
        if (s >= 2 || (s >= 1 && keywords.length <= 2)) cuedFragmentIds.add(f.id);
      }
    }
  }

  logDebug("检索", `关键词: ${keywords.join(", ") || "无"}\n命中: ${hitEvents.length} 条事件 (${Array.from(hitFragments.values()).reduce((s, f) => s + f.length, 0)} 片段，唤起 ${cuedFragmentIds.size} 条)\nTop${topEvents.length}: ${topEvents.map((e) => e.event_text.slice(0, 20)).join(" | ")}\n灵光一闪: ${epiphany ? epiphany.event_text.slice(0, 30) : "未触发"}`);

  return { hitEvents, hitFragments, topEvents, epiphany, keywords, cuedFragmentIds };
}
