// 三个评估脚本共用的检索管线模拟：按标点拆段 → 两通道粗召回 → IDF 加权打分 → 相对截断 → 跨段合并。
//
// 对应 retrieval.ts 的真实流程：
//   按标点拆段 → 每段分词 → 标题/别名 + 片段印象/标签粗召回 → IDF 加权 + 截断 → 跨段按得分合并
// SQL 那一步用等价的字符串包含模拟；拆段、门槛、IDF、截断、同分规则与产品逻辑一致。
import { BLOCKED_NAMES, memoryText } from "../cases/memories.mjs";

/** 命中上限：retrieval.ts 里命中事件 slice(0, 3) */
export const TOP_N = 3;
/** 片段参与打分的字段 */
export const ALL_FIELDS = ["gist", "summary", "kw"];
/** 当前实现的片段打分字段：只认写入时抽的标签（与 retrieval.ts 一致，gist 虚词 bigram 会误召回） */
export const SCORED_FIELDS = ["kw"];

/** 与产品一致的按标点拆段 */
const CLAUSE_SPLIT = /[，。！？；、,.!?;\n\r…]+/;

/**
 * 把记忆库整理成检索池
 * @param memories 记忆数组
 * @param idFrom 起始 id（同分时按 pool 顺序，id 只用于报告与调试）
 */
export function buildPool(memories, idFrom = 1) {
  return memories.map((m, i) => ({
    ...m,
    alias: m.alias ?? "",
    // 真实库里 active_weight 建事件/命中时都写 100，所以同分不能按它排
    active_weight: 100,
    // last_accessed 用 id 序数模拟：越大越新（真实库是 ISO 时间，此处等价比较先后）
    lastAccessed: idFrom + i,
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
 * @param opts.minFn 命中门槛（默认 () => 1 = 命中 1 个关键词即入候选；旧实现按关键词总数分档）
 * @param opts.ratio 相对截断（旧流程用，0 = 不截断）
 * @param opts.strip 先剥离停用词再分词
 * @param opts.idf IDF 加权（当前实现；false = 按命中数打分）
 * @param opts.relCut 相对最高分截断线（当前实现 0.5；0 = 不截）
 * @param opts.clauses 按标点拆段、每段独立检索再按得分合并（当前实现）
 * @param opts.staged 旧流程：标题全部没命中才查片段
 * @param opts.fuzzy 两字词一编辑距离兜底实验（未转正）
 * @param opts.topN 命中上限
 */
export function createRetriever(core, pool, opts = {}) {
  const {
    fields = ALL_FIELDS,
    minFn = () => 1,
    ratio = 0,
    strip = false,
    idf = false,
    relCut = 0,
    clauses = false,
    staged = false,
    fuzzy = null,
    topN = TOP_N,
  } = opts;
  const stripStop = strip ? makeStopStripper(core.stopWords) : (t) => t;

  const pick = (e) => fields.map((f) => e[f] ?? "").join(" ") || (e.kw ? "" : e.gist);
  const titleOf = (e) => `${e.event} ${e.alias}`;
  const has = (text, kw) => kw.some((k) => text.includes(k));

  // IDF：df 用「标题 + 别名 + 打分字段」合并文本统计，模拟真实库的逐词 COUNT
  const fullTextOf = (e) => `${e.event} ${e.alias} ${fields.map((f) => e[f] ?? "").join(" ")}`;
  const dfCache = new Map();
  const idfOf = (kw) => {
    if (!dfCache.has(kw)) {
      const df = pool.reduce((n, e) => n + (fullTextOf(e).includes(kw) ? 1 : 0), 0);
      dfCache.set(kw, Math.log((pool.length + 1) / (df + 1)) + 1);
    }
    return dfCache.get(kw);
  };

  /** 打分并排序：当前实现按 IDF 加权分 + 相对截断 + last_accessed 打破同分；旧实现按命中数 */
  function scoreCandidates(candidates, textOf, kw) {
    const min = minFn(kw);
    if (!idf) {
      const ranked = candidates
        .map((item) => ({ item, score: core.scoreOverlap(textOf(item), kw) }))
        .filter((x) => x.score >= min)
        .sort((a, b) => b.score - a.score);
      if (!ranked.length) return [];
      const top = ranked[0].score;
      return (ratio ? ranked.filter((x) => x.score >= top * ratio) : ranked).map((x) => ({
        item: x.item,
        score: x.score,
      }));
    }
    const scored = candidates
      .map((item) => {
        const text = textOf(item);
        let score = 0;
        let hits = 0;
        for (const k of kw) {
          if (text.includes(k)) {
            score += idfOf(k);
            hits += 1;
          }
        }
        return { item, score, hits };
      })
      .filter((x) => x.hits >= min);
    if (!scored.length) return [];
    const top = Math.max(...scored.map((x) => x.score));
    return scored
      .filter((x) => x.score >= top * relCut)
      .sort((a, b) => b.score - a.score || b.item.lastAccessed - a.item.lastAccessed)
      .map((x) => ({ item: x.item, score: x.score }));
  }

  function searchOnce(text) {
    const kw = core.tokenize(stripStop(text), 16, (g) => core.isBlockedGram(g, BLOCKED_NAMES));
    if (kw.length === 0) return { kw, scored: [] };
    if (!staged) {
      // 现流程：两条通道合并，按「标题 + 别名 + 片段印象/标签」统一排序
      const candidates = new Map();
      for (const e of pool) if (has(titleOf(e), kw)) candidates.set(e.id, e);
      for (const e of pool) if (has(pick(e), kw)) candidates.set(e.id, e);
      return {
        kw,
        scored: scoreCandidates([...candidates.values()], (e) => `${titleOf(e)} ${pick(e)}`, kw),
      };
    }
    // 旧流程：标题全部没命中才查片段
    let scored = scoreCandidates(pool.filter((e) => has(titleOf(e), kw)), titleOf, kw).slice(0, topN);
    if (scored.length === 0) {
      scored = scoreCandidates(pool.filter((e) => has(pick(e), kw)), pick, kw).slice(0, topN);
    }
    return { kw, scored };
  }

  /** 实验（未转正）：两字词一编辑距离兜底。只认「独立成词的两字输入」（长句里的噪音
   *  bigram 不参与）；同位置换一个字 + 全库唯一候选才算 */
  function fuzzyRecover(text) {
    const twoChar = [
      ...new Set(
        (text.match(/[一-鿿]+/g) ?? []).filter(
          (run) => run.length === 2 && core.tokenize(stripStop(run), 16, (g) => core.isBlockedGram(g, BLOCKED_NAMES)).length > 0
        )
      ),
    ];
    if (!twoChar.length) return [];
    const byKw = new Map();
    for (const k of twoChar) {
      const matched = [];
      for (const e of pool) {
        for (const tag of (e.kw ?? "").split(/[,，、\s]+/).filter(Boolean)) {
          if (tag.length !== 2) continue;
          const same0 = tag[0] === k[0];
          const same1 = tag[1] === k[1];
          if (same0 === same1) continue; // 必须恰好一个位置不同
          matched.push({ event: e, tag });
        }
      }
      // 一个词对上多个标签 = 拿不准，这个词放弃
      if (matched.length === 1) byKw.set(k, matched[0]);
    }
    // 多个可用词指向不同事件 = 拿不准，整体放弃
    const ids = [...new Set([...byKw.values()].map((x) => x.event.id))];
    return ids.length === 1 ? [byKw.values().next().value.event] : [];
  }

  return {
    keywords(text) {
      return core.tokenize(stripStop(text), 16, (g) => core.isBlockedGram(g, BLOCKED_NAMES));
    },
    /** 返回 { kw, hits }，hits 是命中的记忆对象（已按相关度排序） */
    retrieve(text) {
      // 当前实现：按标点拆段、每段独立检索、跨段按得分合并
      if (clauses && !staged) {
        const parts = text
          .split(CLAUSE_SPLIT)
          .map((s) => s.trim())
          .filter((s) => /[一-鿿a-zA-Z]{2,}/.test(s));
        const segments = parts.length > 0 ? parts : [text];
        const merged = new Map();
        let kwUnion = [];
        for (const part of segments) {
          const { kw, scored } = searchOnce(part);
          if (!kw.length) continue;
          kwUnion = [...new Set([...kwUnion, ...kw])];
          for (const { item, score } of scored) {
            const cur = merged.get(item.id);
            if (cur) cur.score += score;
            else merged.set(item.id, { item, score });
          }
        }
        if (merged.size > 0) {
          const hits = [...merged.values()]
            .sort((a, b) => b.score - a.score || b.item.lastAccessed - a.item.lastAccessed)
            .slice(0, topN)
            .map((x) => x.item);
          if (hits.length) return { kw: kwUnion, hits };
        }
      } else {
        const { kw, scored } = searchOnce(text);
        const hits = scored.slice(0, topN).map((x) => x.item);
        if (hits.length) return { kw, hits };
      }

      // 兜底：常规关键词一个都没命中时，拿单字线索再找一次。
      // 单字只与「恰好是单字的标签」精确比对（标题/正文含「子」「它」不算）。
      const weak = core.singleCharKeywords(text);
      if (weak.length > 0) {
        const weakCands = pool.filter((e) => has(titleOf(e), weak) || has(pick(e), weak));
        const hits = scoreCandidates(weakCands, (e) => `${titleOf(e)} ${pick(e)}`, weak)
          .filter((x) =>
            (x.item.kw ?? "")
              .split(/[,，、\s]+/)
              .filter((tag) => tag.length === 1)
              .some((tag) => weak.includes(tag))
          )
          .slice(0, topN)
          .map((x) => x.item);
        if (hits.length) return { kw: weak, hits };
      }

      // 实验：两字词一编辑距离兜底
      if (fuzzy) {
        const hits = fuzzyRecover(text);
        if (hits.length) return { kw: ["<编辑距离兜底>"], hits };
      }
      return { kw: [], hits: [] };
    },
  };
}
