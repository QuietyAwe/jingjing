// ============================================================
// P3-3: 本地检索 + 灵光一闪
// 流程: 分词 → 检索事件 → 未命中则检索片段 → 衰减排序 → TopN + 灵光一闪
// ============================================================

import dayjs from "dayjs";
import { tokenize, scoreOverlap, singleCharKeywords } from "./tokenize";
import { blockedWords, isBlockedGram } from "./identity";
import { calculateWeight, calculateWeights, COLD_MEMORY_MAX_WEIGHT } from "./decay";
import { getDB } from "@/db/connection";
import { updateWeight, getAllActive, getFragmentsByEventId, getFragmentsByEventIds, getDefaultEventId, getEventAliasText, getMomentsByIds, getRecentMomentAuthors, getRecentUserCommentedMomentAuthors } from "@/db/queries";
import { EVENT_COLUMNS } from "@/db/schema";
import { getThresholds, getWeightDecay } from "@/prompt/config";
import { getMomentsSeen, getRecentlyRecalledFragmentIds, markMomentRecalled } from "@/moments/seen";
import { momentEventOf } from "@/moments/events";
import { logDebug } from "@/store/chatStore";
import type { MemoryEvent, MemoryFragment } from "@/types/schema";

export interface RetrievalResult {
  /** 命中事件（通过片段匹配关联） */
  hitEvents: MemoryEvent[];
  /** 命中事件的关联片段 */
  hitFragments: Map<number, MemoryFragment[]>;
  /** 被当前输入真正唤起的片段 id（内容与话题有实质重合）——只有它们回到「记得很清楚」，其余片段照常随年龄变模糊 */
  cuedFragmentIds: Set<number>;
  /** 注入记忆区的事件（本轮检索命中的事件） */
  topEvents: (MemoryEvent & { live_weight: number })[];
  /** 1 条冷记忆（灵光一闪，概率触发），带一句 gist 好让 AI 有话可说 */
  epiphany: (MemoryEvent & { gist: string }) | null;
  /** 提取的关键词 */
  keywords: string[];
}

/**
 * 关键词的 IDF 权重：词在库里越常见越没区分度（「加班」撞三条记忆 ≈ 无效词，
 * 「团子」独一份 ≈ 强线索）。df 按「标题/别名/印象/标签」统计，与打分文本同源；
 * 本地量级直接逐词 COUNT，代价可忽略。
 */
function idfWeights(
  db: ReturnType<typeof getDB>,
  kw: string[],
  defaultEventId: number | null
): Map<string, number> {
  const excludeDefault = defaultEventId ? `AND e.id != ${defaultEventId}` : "";
  const n =
    db.getFirstSync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memory_events e WHERE e.event_status != 'upcoming' ${excludeDefault}`
    )?.n ?? 0;
  const map = new Map<string, number>();
  for (const k of kw) {
    const row = db.getFirstSync<{ n: number }>(
      `SELECT COUNT(DISTINCT e.id) AS n
       FROM memory_events e
       LEFT JOIN memory_event_aliases a ON a.event_id = e.id
       LEFT JOIN memory_fragments f ON f."index" = e.id
       WHERE e.event_status != 'upcoming' ${excludeDefault}
         AND (e.event_text LIKE ? OR a.alias LIKE ? OR f.gist LIKE ? OR f.keywords LIKE ?)`,
      `%${k}%`,
      `%${k}%`,
      `%${k}%`,
      `%${k}%`
    );
    const df = row?.n ?? 0;
    map.set(k, Math.log((n + 1) / (df + 1)) + 1);
  }
  return map;
}

/** 相对截断线：加权分低于最高分一半的候选视为「通用词带出来的弱命中」丢弃 */
const REL_CUT = 0.5;

/**
 * 按「IDF 加权重合度」给候选事件排序
 *
 * SQL 侧只做粗召回（OR 匹配），真正的排序在这里做：
 * 分数 = 命中的每个关键词的 IDF 之和，通用词带分少、独一份的词带分多；
 * 与最高分差一半以上的弱命中截掉，防止「周末」「心情」这类词把不相干往事顶进 Top3。
 *
 * 同分不再按创建顺序兜底（那等于永远偏向最早的记忆），改按 last_accessed——
 * 更近被想起过的事件更可能是当前话题。
 *
 * @param pick 从候选里取出用于打分的文本
 */
function rankByOverlap<T extends { last_accessed: string }>(
  candidates: T[],
  pick: (item: T) => string,
  keywords: string[],
  idf: Map<string, number>
): Array<{ item: T; score: number }> {
  // 命中 1 个关键词即入候选：门槛不再按关键词总数计——短句里夹一个跨词噪音 bigram
  // （「有点想家」的「点想」）就会让「必须全中」整句失效。噪音交给 IDF 与相对截断挡。
  const scored = candidates
    .map((item) => {
      const text = pick(item);
      let score = 0;
      let hits = 0;
      for (const k of keywords) {
        if (text.includes(k)) {
          score += idf.get(k) ?? 1;
          hits += 1;
        }
      }
      return { item, score, hits };
    })
    .filter((x) => x.hits >= 1);
  if (scored.length === 0) return [];
  const top = Math.max(...scored.map((x) => x.score));
  return scored
    .filter((x) => x.score >= top * REL_CUT)
    .sort((a, b) => b.score - a.score || (b.item.last_accessed ?? "").localeCompare(a.item.last_accessed ?? ""))
    .map((x) => ({ item: x.item, score: x.score }));
}

/** 命中归因：哪个检索词撞上了哪条记忆的哪个字段，口径与打分文本一致 */
function describeHits(
  events: MemoryEvent[],
  keywords: string[],
  aliases: Map<number, string>,
  fragments: Map<number, MemoryFragment[]>
): string {
  return events
    .map((e) => {
      const frags = fragments.get(e.id) ?? [];
      const hits: string[] = [];
      for (const k of keywords) {
        const where: string[] = [];
        if (e.event_text.includes(k)) where.push("标题");
        if ((aliases.get(e.id) ?? "").includes(k)) where.push("别名");
        if (frags.some((f) => f.gist.includes(k))) where.push("印象");
        if (frags.some((f) => f.keywords.includes(k))) where.push("检索词");
        if (where.length > 0) hits.push(`「${k}」→${where.join("/")}`);
      }
      return `#${e.id} ${e.event_text.slice(0, 16)}：${hits.join("、") || "无直接命中"}`;
    })
    .join("\n");
}

/** 动态新近度窗口：超过这个时长，帖子不再算「刚发生」 */
const MOMENT_RECENCY_HOURS = 6;
/** 「用户刚浏览过」的有效时长 */
const MOMENT_SEEN_WINDOW_MINUTES = 60;
/** 近期动态通道的概率上限：留一点不确定性，避免「每轮必提一句」的机械感 */
const RECALL_PROBABILITY_CAP = 0.9;

/**
 * 动态新近度 → 灵光一闪的事件权重倍数
 *
 * 刚发/刚被用户评论的帖子 4× > 用户刚发的、用户刚浏览过的 2.5× > 其他好友刚发的 1.5×。
 * 事件按帖子作者归属（见 moments/events.ts），同一事件取最高倍数。
 */
function recentMomentBoost(now: dayjs.Dayjs = dayjs()): Map<string, number> {
  const boost = new Map<string, number>();
  const bump = (event: string, times: number) => {
    boost.set(event, Math.max(boost.get(event) ?? 1, times));
  };
  const sinceIso = now.subtract(MOMENT_RECENCY_HOURS, "hour").toISOString();

  for (const author of getRecentMomentAuthors(sinceIso)) {
    bump(momentEventOf(author), author === "ai" ? 4 : author === "user" ? 2.5 : 1.5);
  }
  // 用户刚在帖子下评论：那个帖子（按作者归事件）大幅提高
  for (const author of getRecentUserCommentedMomentAuthors(sinceIso)) {
    bump(momentEventOf(author), 4);
  }
  // 用户刚在动态页刷到的帖子：中等提高
  const seen = getMomentsSeen();
  if (seen && now.diff(dayjs(seen.at), "minute") <= MOMENT_SEEN_WINDOW_MINUTES) {
    for (const m of getMomentsByIds(seen.ids)) bump(momentEventOf(m.author), 2.5);
  }
  return boost;
}

/** 近期动态的灵光一闪候选 */
interface RecentRecall {
  event: MemoryEvent & { live_weight: number };
  boost: number;
  fragment: MemoryFragment;
}

/**
 * 近期动态候选：只取「6 小时内、还没被提过」的最新片段。
 * 已被检索命中注入（topIds）或去重窗口内提过的事件都不算——同一句话不该连着说两遍。
 */
function recentMomentRecallCandidates(
  events: (MemoryEvent & { live_weight: number })[],
  topIds: Set<number>
): RecentRecall[] {
  const boostMap = recentMomentBoost();
  if (boostMap.size === 0) return [];

  const recalled = getRecentlyRecalledFragmentIds();
  const cutoff = dayjs().subtract(MOMENT_RECENCY_HOURS, "hour");
  const out: RecentRecall[] = [];
  for (const e of events) {
    const boost = boostMap.get(e.event_text);
    if (!boost || topIds.has(e.id)) continue;
    // getFragmentsByEventId 按 timestamp 升序，最后一条就是最近的
    const frags = getFragmentsByEventId(e.id).filter(
      (f) => !recalled.has(f.id) && dayjs(f.timestamp).isAfter(cutoff)
    );
    const fragment = frags[frags.length - 1];
    if (fragment) out.push({ event: e, boost, fragment });
  }
  return out;
}

/** 按权重随机抽一个 */
function pickWeighted<T>(items: T[], weights: number[]): T {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** 长句按标点/换行拆段：每段独立提词检索，实体词不靠「关键词抽样」的运气 */
function splitClauses(text: string): string[] {
  const parts = text
    .split(/[，。！？；、,.!?;\n\r…]+/)
    .map((s) => s.trim())
    .filter((s) => /[一-鿿a-zA-Z]{2,}/.test(s));
  return parts.length > 0 ? parts : [text];
}

/**
 * 完整本地检索流程
 *
 * 输入按标点拆段，每段独立走「两条召回通道合并排序」，最后按得分合并取 Top3
 */
export function retrieve(userInput: string): RetrievalResult {
  // 1. 分词（bigram，见 tokenize.ts 的说明）
  // 屏蔽词（默认是身份名：用户昵称 / AI 名称，可在「检索屏蔽词」设置里自定义高频词）
  // 不当检索词：几乎每条记忆都带名字，输入里一提名字就会把一堆无关记忆误命中
  const blocked = blockedWords();
  const isStop = (g: string) => isBlockedGram(g, blocked);
  /** 实际把记忆勾出来的那组词：各段分词去重后的并集，或单字兜底时的单字 */
  let triggerKeywords: string[] = [];
  /** 命中来路：单字兜底时为真（用于日志） */
  let usedWeak = false;

  let hitEvents: MemoryEvent[] = [];
  /** 只靠别名命中（标题完全没对上）的事件数：排查合并是否让事件变得检索不到 */
  let aliasOnlyHits = 0;
  const hitEventIds = new Set<number>();
  const db = getDB();
  const defaultEventId = getDefaultEventId();

  // 2. 两条召回通道：事件标题/别名、片段内容。任意一条对上都算「想起来」，合并排序。
  //
  //    不能「标题没命中才看片段」：一句话提三件事时（「压力大，团子还生病了」），
  //    一个弱标题命中（「团子」）会把另外两件吃掉。
  //
  //    片段只认 gist（一句话印象）+ keywords（写入时抽的标签）——这两样才是写入方对
  //    「这段记忆关于什么」的判断。summary 是完整叙述，拿它撞词会被「有点/觉得/一个人」
  //    这类虚词带偏（「地铁上有人吵架」撞进「和小陈吵架」）。
  function search(kw: string[]): Array<{ item: MemoryEvent; score: number }> {
    // upcoming 约定不参与记忆检索：它们由状态区的「安排」和时间提醒负责
    const excludeDefault = [
      defaultEventId ? `AND e.id != ${defaultEventId}` : "",
      "AND e.event_status != 'upcoming'",
    ]
      .filter(Boolean)
      .join(" ");
    const eventColumns = EVENT_COLUMNS.split(", ").map((c) => `e.${c}`).join(", ");
    const likeParams = kw.flatMap((k) => [`%${k}%`, `%${k}%`]);

    // 通道 1：标题或别名（合并后旧标题进 aliases，用户仍可能用旧说法提起）
    const titleConditions = kw
      .map(
        () =>
          "(e.event_text LIKE ? OR EXISTS(SELECT 1 FROM memory_event_aliases a WHERE a.event_id = e.id AND a.alias LIKE ?))"
      )
      .join(" OR ");
    // 粗排用 last_accessed：引擎只把 active_weight 写成 100，按它排等于按 id 排
    const titleRows = db.getAllSync<MemoryEvent>(
      `SELECT ${eventColumns} FROM memory_events e
       WHERE 1 = 1 ${excludeDefault} AND (${titleConditions})
       ORDER BY e.last_accessed DESC
       LIMIT 15`,
      ...likeParams
    );

    // 通道 2：片段内容
    const fragConditions = kw.map(() => "(f.gist LIKE ? OR f.keywords LIKE ?)").join(" OR ");
    const fragRows = db.getAllSync<MemoryEvent>(
      `SELECT DISTINCT ${eventColumns} FROM memory_events e
       INNER JOIN memory_fragments f ON e.id = f."index"
       WHERE 1 = 1 ${excludeDefault}
         AND LENGTH(f.summary) >= 10
         AND (${fragConditions})
       ORDER BY e.last_accessed DESC
       LIMIT 10`,
      ...likeParams
    );

    // 合并去重后统一打分：标题 + 别名 + 该事件所有片段的「印象 + 标签」
    const byId = new Map<number, MemoryEvent>();
    for (const row of [...titleRows, ...fragRows]) byId.set(row.id, row);
    const candidates = [...byId.values()];
    const aliasText = getEventAliasText(candidates.map((e) => e.id));
    const frags = getFragmentsByEventIds(candidates.map((e) => e.id));
    return rankByOverlap(
      candidates,
      (e) =>
        `${e.event_text} ${aliasText.get(e.id) ?? ""} ${(frags.get(e.id) ?? [])
          .map((f) => `${f.gist} ${f.keywords}`)
          .join(" ")}`,
      kw,
      idfWeights(db, kw, defaultEventId)
    );
  }

  // 每段独立检索再合并：跨段重复命中的事件得分累加（多次被提到 ≈ 更相关）
  const merged = new Map<number, { event: MemoryEvent; score: number }>();
  for (const part of splitClauses(userInput)) {
    const kw = tokenize(part, 16, isStop);
    if (kw.length === 0) continue;
    triggerKeywords = [...new Set([...triggerKeywords, ...kw])];
    for (const { item, score } of search(kw)) {
      const cur = merged.get(item.id);
      if (cur) cur.score += score;
      else merged.set(item.id, { event: item, score });
    }
  }
  if (merged.size > 0) {
    hitEvents = [...merged.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.event.last_accessed ?? "").localeCompare(a.event.last_accessed ?? "")
      )
      .slice(0, 3)
      .map((x) => x.event);
  }

  // 3. 兜底：常规关键词一个都没命中时，拿单字线索再找一次。
  //    「猫」这种单字在分词层就被丢掉，只走这里的单字通道才能想得起来。
  //
  //    只认「标签里恰好有一个单字标签」：标签是「吃面」时单字「吃」不算，
  //    标题/正文里含「子」「它」这种字也不算——单字太泛，一旦按字面包含就会满盘误命中。
  if (hitEvents.length === 0) {
    const weak = singleCharKeywords(userInput, isStop);
    if (weak.length > 0) {
      const candidates = search(weak);
      const frags = getFragmentsByEventIds(candidates.map((x) => x.item.id));
      hitEvents = candidates
        .filter(({ item }) =>
          (frags.get(item.id) ?? []).some((f) =>
            f.keywords
              .split(/[,，、\s]+/)
              .filter((tag) => tag.length === 1)
              .some((tag) => weak.includes(tag))
          )
        )
        .slice(0, 3)
        .map((x) => x.item);
      if (hitEvents.length > 0) {
        triggerKeywords = weak;
        usedWeak = true;
      }
    }
  }

  const keywords = triggerKeywords;

  const aliasText = getEventAliasText(hitEvents.map((e) => e.id));
  if (hitEvents.length > 0) {
    aliasOnlyHits = hitEvents.filter((e) => {
      const alias = aliasText.get(e.id) ?? "";
      return (
        !!alias &&
        scoreOverlap(alias, keywords) > 0 &&
        scoreOverlap(e.event_text, keywords) === 0
      );
    }).length;
    hitEvents.forEach((e) => hitEventIds.add(e.id));
  }

  // 4. 仅达标命中才刷新权重（写库）+ 批量获取关联片段
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
  // 引擎不会写低它（设置页可手改，命中即刷回 100），按它排序等于不排序，候选集退化成「最早创建的事件」，
  // 事件数超过候选上限后新记忆就再也进不了记忆区。
  // 实时权重只依赖 last_accessed / priority，直接全量计算即可（本地数据量级可忽略）。
  const allActive = getAllActive();
  const withLiveWeight = calculateWeights(allActive).sort(
    (a, b) => b.live_weight - a.live_weight
  );
  // updateWeight 刚把命中事件刷成 100/now，但 hitEvents 是刷新前 SELECT 出的旧对象，
  // 继续用 e.last_accessed 会把「刚被想起」算成低权重：截断时命中记忆反而最先被丢
  const hitAt = new Date().toISOString();
  const hitWeighted = hitEvents.map((e) => ({
    ...e,
    active_weight: 100,
    last_accessed: hitAt,
    live_weight: calculateWeight(100, hitAt, e.priority, e.memory_kind),
  }));
  // 记忆区只给本轮真正命中的事件（检索已限 Top3）；无关旧事由会话摘要与灵光一闪承担
  const topEvents = hitWeighted;

  // 6. 灵光一闪：两条通道，只注入一条
  //    ① 近期动态：概率由新近度权重累加得出（用户刚评论/自己刚发帖 ≈ 0.85）
  //    ② 冷记忆：没有新鲜事时的偶然想起，概率 epiphany_trigger_probability
  const { epiphany_trigger_probability } = getWeightDecay();
  const { recent_moment_recall_weight } = getThresholds();
  const topIds = new Set(topEvents.map((e) => e.id));
  let epiphany: (MemoryEvent & { gist: string }) | null = null;
  let epiphanyNote = "未触发";

  const recent = recentMomentRecallCandidates(withLiveWeight, topIds);
  const pRecent =
    recent.length > 0
      ? Math.min(
          RECALL_PROBABILITY_CAP,
          epiphany_trigger_probability +
            recent.reduce((sum, c) => sum + c.boost * recent_moment_recall_weight, 0)
        )
      : 0;

  if (recent.length > 0 && Math.random() < pRecent) {
    const picked = pickWeighted(recent, recent.map((c) => c.boost));
    markMomentRecalled(picked.fragment.id);
    // 注入一句话印象；事件标题不显示，AI 得靠这句接得上话
    epiphany = { ...picked.event, gist: picked.fragment.gist || picked.event.event_text };
    epiphanyNote = `${picked.event.event_text.slice(0, 30)}（近期动态 x${picked.boost}, P=${pRecent.toFixed(2)}）`;
  } else if (keywords.length > 0 && Math.random() < epiphany_trigger_probability) {
    // 冷记忆通道：动态通道没掷中，或根本没有近期动态
    const cold = withLiveWeight.filter(
      (e) => e.live_weight < COLD_MEMORY_MAX_WEIGHT && !topIds.has(e.id)
    );
    if (cold.length > 0) {
      // 优先挑「和当前输入有弱关联」的冷记忆——真实的突然想起是被什么触发的，不是掷骰子
      const scored = cold
        .map((e) => ({ e, s: scoreOverlap(e.event_text, keywords) }))
        .filter((x) => x.s >= 1)
        .sort((a, b) => b.s - a.s);
      const pool = scored.length > 0 ? scored.slice(0, 3).map((x) => x.e) : cold;
      const picked = pool[Math.floor(Math.random() * pool.length)];
      const gist =
        getFragmentsByEventId(picked.id).slice(-1)[0]?.gist || picked.event_text;
      epiphany = { ...picked, gist };
      epiphanyNote = `${picked.event_text.slice(0, 30)}（冷记忆）`;
    }
  }

  // 8. 无命中时不注入任何兜底记忆：
  //    近期的事已经由状态区的「当前处境」覆盖，硬塞「日常闲聊」只会
  //    占记忆区预算、还可能引出与当前话题无关的内容

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

  const topLine =
    topEvents.length > 0
      ? `Top${topEvents.length}: ${topEvents.map((e) => e.event_text.slice(0, 20)).join(" | ")}`
      : "未命中：不注入记忆区";
  const hitLine = describeHits(hitEvents, triggerKeywords, aliasText, hitFragments);
  const viaNote = usedWeak ? ` → 单字兜底: ${triggerKeywords.join(", ")}` : "";
  logDebug(
    "检索",
    `关键词: ${keywords.join(", ") || "无"}${viaNote}\n命中: ${hitEvents.length} 条事件（别名独中 ${aliasOnlyHits} 条，${Array.from(hitFragments.values()).reduce((s, f) => s + f.length, 0)} 片段，唤起 ${cuedFragmentIds.size} 条）\n触发:\n${hitLine || "无"}\n${topLine}\n灵光一闪: ${epiphanyNote}`
  );

  return { hitEvents, hitFragments, topEvents, epiphany, keywords, cuedFragmentIds };
}
