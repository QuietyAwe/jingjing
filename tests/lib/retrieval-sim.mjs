// 三个评估脚本共用的检索管线模拟：粗召回两阶段 + 命中门槛 + 相对截断。
//
// 对应 retrieval.ts 的真实流程：
//   分词 → 事件标题/别名粗召回 → 未命中再检索片段 → 打分排序取 Top N
// SQL 那一步用等价的字符串包含模拟；门槛、截断、分词、打分都是真实函数。
import { BLOCKED_NAMES, memoryText } from "../cases/memories.mjs";

/** 命中上限：retrieval.ts 里两处都是 slice(0, 3) */
export const TOP_N = 3;
/** 片段参与打分的字段 */
export const ALL_FIELDS = ["gist", "summary", "kw"];
/** 只认写入时 LLM 抽的关键词 */
export const KEYWORD_FIELDS = ["kw"];
/** 当前实现的片段打分字段：一句话印象 + 写入时抽的标签（与 retrieval.ts 一致） */
export const SCORED_FIELDS = ["gist", "kw"];

/**
 * 把记忆库整理成检索池
 * @param memories 记忆数组
 * @param idFrom 起始 id（同分时按 pool 顺序，id 只用于报告与调试）
 */
export function buildPool(memories, idFrom = 1) {
  return memories.map((m, i) => ({
    ...m,
    alias: m.alias ?? "",
    // 真实库里 active_weight 建事件/命中时都写 100，所以同分只能靠池子顺序
    active_weight: 100,
    id: idFrom + i,
    text: memoryText(m),
  }));
}

/** 停用词表 → 先按整词剥离再分词的函数（长词优先，避免拆碎） */
export function makeStopStripper(stopWords) {
  const multi = [...stopWords]
    .filter((w) => w.length >= 2 && /^[一-鿿]+$/.test(w))
    .sort((a, b) => b.length - a.length);
  return (text) => multi.reduce((t, w) => t.split(w).join(""), text);
}

/**
 * 建一个检索器
 * @param core loadRetrievalCore() 的返回值
 * @param pool buildPool() 的结果
 * @param opts.fields 参与片段打分的字段（默认全部）
 * @param opts.minFn 命中门槛（默认当前实现 minHitScore；() => 1 = 命中即算）
 * @param opts.ratio 相对截断（0 = 不截断，0.5 = 与最高分差一半以上丢弃）
 * @param opts.strip 先剥离停用词再分词
 * @param opts.useRealRank 直接用真实 rankByOverlap（当前实现的门槛与排序）
 * @param opts.staged 旧流程：标题全部没命中才查片段（当前实现是两条通道合并）
 * @param opts.topN 命中上限
 */
export function createRetriever(core, pool, opts = {}) {
  const {
    fields = ALL_FIELDS,
    minFn = core.minHitScore,
    ratio = 0,
    strip = false,
    useRealRank = false,
    staged = false,
    topN = TOP_N,
  } = opts;
  const stripStop = strip ? makeStopStripper(core.stopWords) : (t) => t;

  const pick = (e) => fields.map((f) => e[f] ?? "").join(" ") || (e.kw ? "" : e.gist);
  const titleOf = (e) => `${e.event} ${e.alias}`;
  const has = (text, kw) => kw.some((k) => text.includes(k));

  function rank(candidates, textOf, kw) {
    if (useRealRank) return core.rankByOverlap(candidates, textOf, kw);
    const min = minFn(kw);
    const ranked = candidates
      .map((item) => ({ item, score: core.scoreOverlap(textOf(item), kw) }))
      .filter((x) => x.score >= min)
      .sort((a, b) => b.score - a.score); // 同分保持池子顺序（真实库里 active_weight 全是 100）
    if (!ranked.length) return [];
    const top = ranked[0].score;
    return (ratio ? ranked.filter((x) => x.score >= top * ratio) : ranked).map((x) => x.item);
  }

  return {
    keywords(text) {
      return core.tokenize(stripStop(text), 16, (g) => core.isBlockedGram(g, BLOCKED_NAMES));
    },
    /** 返回 { kw, hits }，hits 是命中的记忆对象（已按相关度排序） */
    retrieve(text) {
      const kw = this.keywords(text);
      // 旧流程：标题全部没命中才查片段
      if (staged) {
        if (kw.length === 0) return { kw, hits: [] };
        let hits = rank(pool.filter((e) => has(titleOf(e), kw)), titleOf, kw).slice(0, topN);
        if (hits.length === 0) {
          hits = rank(pool.filter((e) => has(pick(e), kw)), pick, kw).slice(0, topN);
        }
        return { kw, hits };
      }

      // 现流程：两条通道合并，按「标题 + 别名 + 片段印象/标签」统一排序
      let hits = [];
      if (kw.length > 0) {
        const candidates = new Map();
        for (const e of pool) if (has(titleOf(e), kw)) candidates.set(e.id, e);
        for (const e of pool) if (has(pick(e), kw)) candidates.set(e.id, e);
        hits = rank([...candidates.values()], (e) => `${titleOf(e)} ${pick(e)}`, kw).slice(0, topN);
      }

      // 兜底：常规关键词一个都没命中时，拿单字线索再找一次。
      // 单字只与「恰好是单字的标签」精确比对（标题/正文含「子」「它」不算）。
      if (hits.length === 0) {
        const weak = core.singleCharKeywords(text);
        if (weak.length > 0) {
          const weakCands = pool.filter((e) => has(titleOf(e), weak) || has(pick(e), weak));
          hits = rank(weakCands, (e) => `${titleOf(e)} ${pick(e)}`, weak)
            .filter((e) =>
              (e.kw ?? "")
                .split(/[,，、\s]+/)
                .filter((tag) => tag.length === 1)
                .some((tag) => weak.includes(tag))
            )
            .slice(0, topN);
          return { kw: weak, hits };
        }
      }
      return { kw, hits };
    },
  };
}
