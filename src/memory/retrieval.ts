// ============================================================
// 检索：AI 判定主路径 + 本地兜底 + 灵光一闪
//
// 主路径把全部未被遗忘的记忆摆成清单交给模型判断（见 judge.ts），
// 本地关键词检索只剩两处职责：AI 不可用时的兜底，以及灵光一闪。
// ============================================================

import dayjs from "dayjs";
import { tokenize, scoreOverlap, singleCharKeywords } from "./tokenize";
import { blockedWords, isBlockedGram } from "./identity";
import { calculateWeight, calculateWeights, COLD_MEMORY_MAX_WEIGHT } from "./decay";
import { buildMemoryList, judgeRecall, MEMORY_LIST_MIN_WEIGHT } from "./judge";
import { isChitchatOnly } from "./chitchat";
import { getDB } from "@/db/connection";
import {
  updateWeight,
  getAllActive,
  getFragmentsByEventId,
  getFragmentsByEventIds,
  getDefaultEventId,
  getEventAliasText,
  getMomentsByIds,
  getRecentMomentAuthors,
  getRecentUserCommentedMomentAuthors,
  insertRetrievalLog,
  getMeta,
  setMeta,
} from "@/db/queries";
import { EVENT_COLUMNS } from "@/db/schema";
import { getThresholds, getWeightDecay } from "@/prompt/config";
import { getMomentsSeen, getRecentlyRecalledFragmentIds, markMomentRecalled } from "@/moments/seen";
import { momentEventOf } from "@/moments/events";
import { hasApiKey } from "@/llm/client";
import { useSettingsStore } from "@/store/settingsStore";
import { logDebug } from "@/store/chatStore";
import type { MemoryEvent, MemoryFragment, RecallPlanItem } from "@/types/schema";

export interface RetrievalResult {
  /** 命中事件（AI 选中 / 兜底命中） */
  hitEvents: MemoryEvent[];
  /** 命中事件的关联片段：主路径给全部片段，详略由档位与指认决定 */
  hitFragments: Map<number, MemoryFragment[]>;
  /** 被当前输入真正唤起的片段 id——只有兜底路径使用，主路径为空集 */
  cuedFragmentIds: Set<number>;
  /** 注入记忆区的事件 */
  topEvents: (MemoryEvent & { live_weight: number })[];
  /** 1 条冷记忆（灵光一闪，概率触发），带一句 gist 好让 AI 有话可说 */
  epiphany: (MemoryEvent & { gist: string }) | null;
  /** 兜底路径的检索词；主路径留空（判定不靠字面） */
  keywords: string[];
  /** 每条注入事件的档位与指认片段；兜底路径为空 Map */
  plan: Map<number, RecallPlanItem>;
  /** 1 = 本地兜底接管 */
  fallback: boolean;
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
         AND (e.event_text LIKE ? OR a.alias LIKE ? OR f.keywords LIKE ?)`,
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
        if (frags.some((f) => f.keywords.includes(k))) where.push("标签");
        if (where.length > 0) hits.push(`「${k}」→${where.join("/")}`);
      }
      return `#${e.id} ${e.event_text.slice(0, 16)}：${hits.join("、") || "无直接命中"}`;
    })
    .join("\n");
}

/** 长句按标点/换行拆段：每段独立提词检索，实体词不靠「关键词抽样」的运气 */
function splitClauses(text: string): string[] {
  const parts = text
    .split(/[，。！？；、,.!?;\n\r…]+/)
    .map((s) => s.trim())
    .filter((s) => /[一-鿿a-zA-Z]{2,}/.test(s));
  return parts.length > 0 ? parts : [text];
}

/** 检索词并集：灵光一闪的弱关联与调试日志用，不参与 AI 判定 */
function extractKeywords(text: string): string[] {
  const blocked = blockedWords();
  const isStop = (g: string) => isBlockedGram(g, blocked);
  const out: string[] = [];
  for (const part of splitClauses(text)) {
    for (const k of tokenize(part, 16, isStop)) {
      if (!out.includes(k)) out.push(k);
    }
  }
  return out;
}

// ============================================================
// 本地兜底检索（无 Key / 关闭开关 / 判定失败时接管）
// ============================================================

interface LocalResult {
  hitEvents: MemoryEvent[];
  hitFragments: Map<number, MemoryFragment[]>;
  cuedFragmentIds: Set<number>;
  keywords: string[];
  aliasText: Map<number, string>;
  usedWeak: boolean;
  aliasOnlyHits: number;
}

/**
 * 完整本地检索流程
 *
 * 输入按标点拆段，每段独立走「两条召回通道合并排序」，最后按得分合并取 Top3。
 * `allowedIds` 与主路径同口径：权重跌破遗忘线的事件连兜底也不召回。
 */
function localRetrieve(userInput: string, allowedIds: Set<number>): LocalResult {
  const blocked = blockedWords();
  const isStop = (g: string) => isBlockedGram(g, blocked);
  let triggerKeywords: string[] = [];
  let usedWeak = false;
  let hitEvents: MemoryEvent[] = [];
  let aliasOnlyHits = 0;
  const db = getDB();
  const defaultEventId = getDefaultEventId();

  // 两条召回通道：事件标题/别名、片段内容。任意一条对上都算「想起来」，合并排序。
  // 不能「标题没命中才看片段」：一句话提三件事时，一个弱标题命中会把另外两件吃掉。
  // 片段只认 keywords：gist 是完整句子，虚词 bigram（如「了没」）会撞出误召回；summary 同理。
  function search(kw: string[]): Array<{ item: MemoryEvent; score: number }> {
    const excludeDefault = [
      defaultEventId ? `AND e.id != ${defaultEventId}` : "",
      "AND e.event_status != 'upcoming'",
    ]
      .filter(Boolean)
      .join(" ");
    const eventColumns = EVENT_COLUMNS.split(", ").map((c) => `e.${c}`).join(", ");
    // 标题通道每词 2 个参数（标题 + 别名）；片段通道只认标签，每词 1 个
    const likeParams = kw.flatMap((k) => [`%${k}%`, `%${k}%`]);
    const fragParams = kw.map((k) => `%${k}%`);

    const titleConditions = kw
      .map(
        () =>
          "(e.event_text LIKE ? OR EXISTS(SELECT 1 FROM memory_event_aliases a WHERE a.event_id = e.id AND a.alias LIKE ?))"
      )
      .join(" OR ");
    const titleRows = db.getAllSync<MemoryEvent>(
      `SELECT ${eventColumns} FROM memory_events e
       WHERE 1 = 1 ${excludeDefault} AND (${titleConditions})
       ORDER BY e.last_accessed DESC
       LIMIT 15`,
      ...likeParams
    );

    const fragConditions = kw.map(() => "f.keywords LIKE ?").join(" OR ");
    const fragRows = db.getAllSync<MemoryEvent>(
      `SELECT DISTINCT ${eventColumns} FROM memory_events e
       INNER JOIN memory_fragments f ON e.id = f."index"
       WHERE 1 = 1 ${excludeDefault}
         AND LENGTH(f.summary) >= 10
         AND (${fragConditions})
       ORDER BY e.last_accessed DESC
       LIMIT 10`,
      ...fragParams
    );

    const byId = new Map<number, MemoryEvent>();
    for (const row of [...titleRows, ...fragRows]) {
      if (allowedIds.has(row.id)) byId.set(row.id, row);
    }
    const candidates = [...byId.values()];
    const aliasText = getEventAliasText(candidates.map((e) => e.id));
    const frags = getFragmentsByEventIds(candidates.map((e) => e.id));
    return rankByOverlap(
      candidates,
      (e) =>
        `${e.event_text} ${aliasText.get(e.id) ?? ""} ${(frags.get(e.id) ?? [])
          .map((f) => f.keywords)
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

  // 兜底：常规关键词一个都没命中时，拿单字线索再找一次。
  // 「猫」这种单字在分词层就被丢掉，只走这里的单字通道才能想得起来；
  // 只认「标签里恰好有一个单字标签」，单字太泛，按字面包含会满盘误命中。
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
  }

  // 仅达标命中才刷新权重（写库）+ 批量获取关联片段
  const hitFragments = new Map<number, MemoryFragment[]>();
  if (hitEvents.length > 0) {
    for (const event of hitEvents) updateWeight(event.id, 100);
    const fetched = getFragmentsByEventIds(hitEvents.map((e) => e.id));
    for (const [eventId, fragments] of fetched) {
      if (fragments.length > 0) hitFragments.set(eventId, fragments);
    }
  }

  // 兜底路径的详略仍看「被唤起的片段」：内容与当前输入有实质重合才算刚想起来。
  // 判定 ≥2 个不同关键词命中，或输入很短（≤2 个关键词）时 ≥1 即算——
  // 后者让「吃面」这类单词 cue 能唤起对应细节，前者把只撞一个「今天」的噪音挡住。
  const cuedFragmentIds = new Set<number>();
  if (keywords.length > 0) {
    for (const frags of hitFragments.values()) {
      for (const f of frags) {
        const s = scoreOverlap(`${f.gist} ${f.summary} ${f.keywords}`, keywords);
        if (s >= 2 || (s >= 1 && keywords.length <= 2)) cuedFragmentIds.add(f.id);
      }
    }
  }

  return { hitEvents, hitFragments, cuedFragmentIds, keywords, aliasText, usedWeak, aliasOnlyHits };
}

// ============================================================
// 灵光一闪（独立通道，与判定无关）
// ============================================================

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
 * 已被本轮注入（excludeIds）或去重窗口内提过的事件都不算——同一句话不该连着说两遍。
 */
function recentMomentRecallCandidates(
  events: (MemoryEvent & { live_weight: number })[],
  excludeIds: Set<number>
): RecentRecall[] {
  const boostMap = recentMomentBoost();
  if (boostMap.size === 0) return [];

  const recalled = getRecentlyRecalledFragmentIds();
  const cutoff = dayjs().subtract(MOMENT_RECENCY_HOURS, "hour");
  const out: RecentRecall[] = [];
  for (const e of events) {
    const boost = boostMap.get(e.event_text);
    if (!boost || excludeIds.has(e.id)) continue;
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

// ============================================================
// 主入口
// ============================================================

/**
 * 失败计数：连续失败 3 次起在设置页标红。
 *
 * 只写日志的话，Key 过期这类持续故障会让体验静默退回本地检索，用户没有出口。
 */
function noteJudgeFailure(reason: string | undefined): void {
  const streak = Number(getMeta("retrieval_fail_streak") ?? 0) + 1;
  setMeta("retrieval_fail_streak", String(streak));
  setMeta("retrieval_fail_reason", reason ?? "");
}

function clearJudgeFailure(): void {
  if (getMeta("retrieval_fail_streak") !== "0") setMeta("retrieval_fail_streak", "0");
}

/** 同一句话在窗口内重复判定（重新生成 / 编辑重发）直接复用，别为同一句话付两次钱 */
const JUDGE_REUSE_MS = 30 * 60_000;
let lastJudge: { text: string; at: number; hits: RecallPlanItem[]; eventCount: number } | null = null;

/** 本轮选中的事件 → 注入用的事件对象（权重已擦亮成 100/now） */
function polishedTop(
  events: MemoryEvent[],
  hitAt: string
): (MemoryEvent & { live_weight: number })[] {
  return events.map((e) => ({
    ...e,
    active_weight: 100,
    last_accessed: hitAt,
    live_weight: calculateWeight(100, hitAt, e.priority),
  }));
}

/**
 * 完整检索流程
 *
 * 闸门（无实词/纯寒暄）→ AI 判定 → 失败或不可用时本地兜底 → 擦亮 → 灵光一闪。
 * 异步：判定要走一次网络，调用方 await 后沿用手头的「正在输入中」。
 */
export async function retrieve(userInput: string): Promise<RetrievalResult> {
  const withLiveWeight = calculateWeights(getAllActive());
  // 遗忘线：跌破它的事件不再进清单，兜底候选池同口径——否则一降级冷记忆全回来了
  const eligible = withLiveWeight.filter((e) => e.live_weight >= MEMORY_LIST_MIN_WEIGHT);
  const eligibleIds = new Set(eligible.map((e) => e.id));

  const text = userInput.trim();
  // 空输入（游戏回合/开局）、纯寒暄、以及整句只有屏蔽词时都唤不起往事：零事件，省掉一次判定
  const gateSkipped = text === "" || isChitchatOnly(text, blockedWords());
  const aiAvailable = useSettingsStore.getState().ai_retrieval_enabled && hasApiKey();

  let plan: Map<number, RecallPlanItem> | null = null;
  let local: LocalResult | null = null;
  let fallback = false;
  let keywords: string[] = [];
  let judgeNote = "闸门跳过：整句唤不起往事";
  let eventCount = 0;

  const reused =
    lastJudge && lastJudge.text === text && Date.now() - lastJudge.at < JUDGE_REUSE_MS
      ? lastJudge
      : null;

  if (!gateSkipped) {
    keywords = extractKeywords(text);
    if (!aiAvailable) {
      judgeNote = "兜底（AI 判定关闭或未配置 Key）";
      local = localRetrieve(text, eligibleIds);
    } else if (reused) {
      // 重新生成 / 编辑重发：同一句话 30 分钟内不再判一次
      plan = new Map(reused.hits.map((h) => [h.id, h]));
      eventCount = reused.eventCount;
      judgeNote = `复用刚才的判定（同一句话，30 分钟内）：清单 ${eventCount} 条，选中 ${reused.hits.length} 条`;
    } else {
      try {
        const list = buildMemoryList(eligible);
        eventCount = list.entries.length;
        if (eventCount === 0) {
          // 库里还没有可判的记忆（新装 / 已清空）：不调模型、不写日志、不计失败；
          // 本地候选池同样是空的，兜底也跑不出结果
          judgeNote = "清单为空（还没有记忆），不调判定";
        } else {
          const startedAt = Date.now();
          const judged = await judgeRecall(text, list);
          const latencyMs = Date.now() - startedAt;
          if (judged.ok) {
            plan = new Map(judged.hits.map((h) => [h.id, h]));
            lastJudge = { text, at: Date.now(), hits: judged.hits, eventCount };
            judgeNote = `AI 判定：清单 ${eventCount} 条，选中 ${judged.hits.length} 条${
              judged.expandUsed ? "（用过二段）" : ""
            }，${latencyMs}ms`;
            clearJudgeFailure();
          } else {
            fallback = true;
            judgeNote = `兜底（${judged.reason ?? "判定失败"}）：${latencyMs}ms`;
            noteJudgeFailure(judged.reason);
            local = localRetrieve(text, eligibleIds);
          }
          // 被闸门拦下、清单为空的轮次没有判定结果，不写日志；这里一定是真调过模型
          insertRetrievalLog({
            created_at: new Date().toISOString(),
            user_text: text.slice(0, 500),
            stage1_output: judged.stage1,
            stage2_output: judged.stage2,
            final_injected: JSON.stringify(
              (judged.ok ? judged.hits : []).map((h) => h.id)
            ),
            fallback: fallback ? 1 : 0,
            event_count: eventCount,
            expand_used: judged.expandUsed ? 1 : 0,
            latency_ms: latencyMs,
          });
        }
      } catch (err) {
        // 拼清单或判定任何一步抛异常，都不能让这轮聊天发不出去：当判定失败走本地兜底
        fallback = true;
        const reason = err instanceof Error ? err.message : String(err);
        judgeNote = `兜底（判定异常：${reason}）`;
        noteJudgeFailure(reason);
        local = localRetrieve(text, eligibleIds);
      }
    }
  } else {
    keywords = [];
  }

  const hitAt = new Date().toISOString();
  let hitEvents: MemoryEvent[] = [];
  let hitFragments = new Map<number, MemoryFragment[]>();
  let cuedFragmentIds = new Set<number>();
  let topEvents: (MemoryEvent & { live_weight: number })[] = [];
  let aliasText = new Map<number, string>();
  let usedWeak = false;
  let aliasOnlyHits = 0;
  let hitLine = "";

  if (plan) {
    const byId = new Map(eligible.map((e) => [e.id, e]));
    const chosen = [...plan.values()].filter((h) => byId.has(h.id));
    // 擦亮二值：判相关就回到 100，未选中不擦不注
    for (const item of chosen) updateWeight(item.id, 100);
    hitEvents = chosen.map((item) => byId.get(item.id)!);
    topEvents = polishedTop(hitEvents, hitAt);
    const fetched = getFragmentsByEventIds(hitEvents.map((e) => e.id));
    for (const [eventId, fragments] of fetched) {
      if (fragments.length > 0) hitFragments.set(eventId, fragments);
    }
    hitLine = chosen
      .map((h) => `#${h.id} ${h.level}${h.fragId ? ` f${h.fragId}` : ""}`)
      .join("、");
  } else if (local) {
    hitEvents = local.hitEvents;
    hitFragments = local.hitFragments;
    cuedFragmentIds = local.cuedFragmentIds;
    aliasText = local.aliasText;
    usedWeak = local.usedWeak;
    aliasOnlyHits = local.aliasOnlyHits;
    if (local.keywords.length > 0) keywords = local.keywords;
    // localRetrieve 刚把命中事件刷成 100/now，但 hitEvents 是刷新前 SELECT 出的旧对象，
    // 继续用 e.last_accessed 会把「刚被想起」算成低权重：截断时命中记忆反而最先被丢
    topEvents = polishedTop(hitEvents, hitAt);
    hitLine = describeHits(hitEvents, keywords, aliasText, hitFragments);
  }

  // 灵光一闪：两条通道，只注入一条
  // ① 近期动态：概率由新近度权重累加得出（用户刚评论/自己刚发帖 ≈ 0.85）
  // ② 冷记忆：没有新鲜事时的偶然想起，概率 epiphany_trigger_probability
  const { epiphany_trigger_probability } = getWeightDecay();
  const { recent_moment_recall_weight } = getThresholds();
  const excludeIds = new Set(topEvents.map((e) => e.id));
  let epiphany: (MemoryEvent & { gist: string }) | null = null;
  let epiphanyNote = "未触发";

  const recent = recentMomentRecallCandidates(withLiveWeight, excludeIds);
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
    // 命中即擦亮：自然退出冷池几天，避免连抽同一条
    updateWeight(picked.event.id, 100);
    // 注入一句话印象；事件标题不显示，AI 得靠这句接得上话
    // gist 取自本次选中的片段，时间戳也必须跟片段走——事件是合并的，
    // 事件 timestamp 停在几天前首次创建时，用它渲染会把今天的动态标成「3天前」
    epiphany = {
      ...picked.event,
      timestamp: picked.fragment.timestamp,
      gist: picked.fragment.gist || picked.event.event_text,
    };
    epiphanyNote = `${picked.event.event_text.slice(0, 30)}（近期动态 x${picked.boost}, P=${pRecent.toFixed(2)}）`;
  } else if (keywords.length > 0 && Math.random() < epiphany_trigger_probability) {
    // 冷记忆通道：动态通道没掷中，或根本没有近期动态
    const cold = withLiveWeight.filter(
      (e) => e.live_weight < COLD_MEMORY_MAX_WEIGHT && !excludeIds.has(e.id)
    );
    if (cold.length > 0) {
      // 优先挑「和当前输入有弱关联」的冷记忆——真实的突然想起是被什么触发的，不是掷骰子
      const scored = cold
        .map((e) => ({ e, s: scoreOverlap(e.event_text, keywords) }))
        .filter((x) => x.s >= 1)
        .sort((a, b) => b.s - a.s);
      const pool = scored.length > 0 ? scored.slice(0, 3).map((x) => x.e) : cold;
      const picked = pool[Math.floor(Math.random() * pool.length)];
      updateWeight(picked.id, 100);
      const frag = getFragmentsByEventId(picked.id).slice(-1)[0];
      // 同上：gist 与时间戳都取同一条片段，别用事件的旧时间
      epiphany = {
        ...picked,
        timestamp: frag?.timestamp ?? picked.timestamp,
        gist: frag?.gist || picked.event_text,
      };
      epiphanyNote = `${picked.event_text.slice(0, 30)}（冷记忆）`;
    }
  }

  // 无命中时不注入任何兜底记忆：
  // 近期的事已经由状态区的「当前处境」覆盖，硬塞「日常闲聊」只会
  // 占记忆区预算、还可能引出与当前话题无关的内容

  const topLine =
    topEvents.length > 0
      ? `Top${topEvents.length}: ${topEvents.map((e) => e.event_text.slice(0, 20)).join(" | ")}`
      : "未命中：不注入记忆区";
  const viaNote = usedWeak ? ` → 单字兜底: ${keywords.join(", ")}` : "";
  const detailLine = plan
    ? `选中: ${hitLine || "无"}`
    : `命中: ${hitEvents.length} 条事件（别名独中 ${aliasOnlyHits} 条，${Array.from(
        hitFragments.values()
      ).reduce((s, f) => s + f.length, 0)} 片段，唤起 ${cuedFragmentIds.size} 条）\n触发:\n${
        hitLine || "无"
      }`;
  logDebug(
    "检索",
    `${judgeNote}\n关键词: ${keywords.join(", ") || "无"}${viaNote}\n${detailLine}\n${topLine}\n灵光一闪: ${epiphanyNote}`
  );

  return {
    hitEvents,
    hitFragments,
    topEvents,
    epiphany,
    keywords,
    cuedFragmentIds,
    plan: plan ?? new Map(),
    fallback,
  };
}
