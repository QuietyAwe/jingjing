// ============================================================
// AI 检索判定：全量清单 + 两段调用 + 输出校验
//
// 本地只负责「把全部记忆摆成一份清单」，判断哪句话想起哪件事交给模型。
// 请求顺序固定为 system 说明 → 全量清单 → 今天的日期与这句话，
// 前两段逐字节稳定，靠前缀缓存把每轮成本压到几厘钱。
// ============================================================

import dayjs from "dayjs";
import { getClient, hasApiKey } from "@/llm/client";
import { pickUsage, type RawUsage } from "@/llm/usage";
import { getPrompts, getModelRouting } from "@/prompt/config";
import { getFragmentEdges, getRecentFragments, type FragmentEdge } from "@/db/queries";
import { formatTodayLine } from "@/utils/holidays";
import { logDebug } from "@/store/chatStore";
import type { LlmUsage } from "@/store/chatStore";
import type { JudgeOutput, MemoryEvent, RecallLevel, RecallPlanItem } from "@/types/schema";

/** 清单排除线：实时权重低于它的事件算「已经淡到会被遗忘」，不再参与判定 */
export const MEMORY_LIST_MIN_WEIGHT = 15;

/** 选中上限（超出按 core 优先截断） */
const MAX_HITS = 6;
/** 一段请求展开上限 */
const MAX_EXPAND = 5;
/** 单段判定超时：典型 300~1000ms，超了就交给兜底，两段最坏 10s */
const JUDGE_TIMEOUT_MS = 5000;

/** 请求日志的体积上限：清单再长也只记这么多字，避免几十条日志把内存撑爆 */
const MAX_LOGGED_PROMPT = 20000;

/** 把日志正文按上限截断（超过上限注明总长度） */
function clipForLog(text: string): string {
  return text.length > MAX_LOGGED_PROMPT
    ? `${text.slice(0, MAX_LOGGED_PROMPT)}\n\n…（已截断，完整 ${text.length} 字）`
    : text;
}

/** 把一次请求的完整内容写进调试日志 */
function logRequest(label: string, text: string): void {
  logDebug("检索判定请求", `${label}\n\n${clipForLog(text)}`);
}

/** 模型原始返回：解析失败也照样记，方便拿着请求原文复现 */
function logReturn(label: string, text: string | null, reason?: string): void {
  const body = text ?? `（无返回${reason ? `：${reason}` : ""}）`;
  logDebug("检索判定返回", `${label}\n\n${clipForLog(body)}`);
}

export interface MemoryListEntry {
  event: MemoryEvent & { live_weight: number };
  /** 最早一条片段 */
  first: FragmentEdge | null;
  /** 最近一条片段 */
  last: FragmentEdge | null;
}

export interface MemoryList {
  /** 喂给模型的清单文本（id 升序、绝对日期、固定称呼） */
  text: string;
  entries: MemoryListEntry[];
  /** 每个事件在清单里展示过的片段编号——第一段的 frag 只能从这里选 */
  shown: Map<number, Set<number>>;
}

/** 绝对日期：同年只写月日，跨年补年份。相对说法每天变，会把清单缓存打爆 */
function absoluteDay(iso: string): string {
  const d = dayjs(iso);
  return d.isValid()
    ? d.year() === dayjs().year()
      ? `${d.month() + 1}月${d.date()}日`
      : `${d.year()}年${d.month() + 1}月${d.date()}日`
    : "";
}

/**
 * 清单文本的占位符渲染
 *
 * `[user]` 固定写「用户」、`[ai]` 固定写「你」：昵称可在设置页改，一改整份清单全变、
 * 缓存全废；真名对判定没有信息增量，反而每条重复出现、稀释区分度。
 */
function renderLine(text: string, timestamp: string): string {
  return text
    .replace(/\[user\]/gi, "用户")
    .replace(/\[ai\]/gi, "你")
    .replace(/\[time\]/gi, absoluteDay(timestamp))
    .replace(/\[now\]/gi, absoluteDay(dayjs().toISOString()))
    .trim();
}

/**
 * 片段印象渲染：`[time]` 换成该片段的绝对日期
 *
 * 没写 `[time]` 且与事件不在同一天时补日期前缀（同一天则由行首日期代表，不重复）。
 */
function renderGist(gist: string, fragTs: string, eventTs: string): string {
  const text = renderLine(gist, fragTs);
  if (/\[time\]/i.test(gist)) return text;
  const fragDay = absoluteDay(fragTs);
  return fragDay && fragDay !== absoluteDay(eventTs) ? `${fragDay} ${text}` : text;
}

/**
 * 构建全量清单
 *
 * 每行「#id 标题 — 日期 — [f91] 一句印象 — [f88] 一句印象」：片段编号是指认细节的唯一依据，
 * AI 看不到的东西没法指认；只摆最近 1 条 + 最早 1 条，避免上千条库稀释注意力。
 */
export function buildMemoryList(events: (MemoryEvent & { live_weight: number })[]): MemoryList {
  const sorted = [...events].sort((a, b) => a.id - b.id);
  const edges = getFragmentEdges(sorted.map((e) => e.id));
  const shown = new Map<number, Set<number>>();
  const entries: MemoryListEntry[] = [];
  const lines: string[] = [];

  for (const event of sorted) {
    const { first, last } = edges.get(event.id) ?? { first: null, last: null };
    // 一条片段都没有的孤立事件：判中了也渲染不出内容，别白占一行
    if (!first && !last) continue;

    const parts = [`#${event.id}`, renderLine(event.event_text, event.timestamp)];
    const day = absoluteDay(event.timestamp);
    // 已结束的处境要标出来，否则模型会把「感冒了」当成现在还在
    if (day) parts.push(event.memory_kind === "condition" && event.closed_at ? `${day}（已结束）` : day);

    const ids = new Set<number>();
    for (const frag of [last, first]) {
      if (!frag || ids.has(frag.id)) continue;
      ids.add(frag.id);
      parts.push(`[f${frag.id}] ${renderGist(frag.gist, frag.timestamp, event.timestamp)}`);
    }

    shown.set(event.id, ids);
    entries.push({ event, first, last });
    lines.push(parts.join(" — "));
  }

  return { text: lines.join("\n"), entries, shown };
}

/** JSON mode 也可能带代码块包裹或前后废话：取第一个 {...} 再解析 */
function parseJudgeOutput(raw: string | null | undefined): JudgeOutput | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as JudgeOutput;
  } catch {
    return null;
  }
}

/**
 * 校验并归一化选中项
 *
 * 程序负责守规矩：`level` 非法按 related（少给细节）、id 不存在丢弃、
 * frag 不在可选池里就丢这个字段（事件仍然注入）。第一段的池是清单展示的两条，
 * 第二段的池是本次展开给模型看过的片段——看过的细节才能被指认。
 */
function normalizeHits(
  raw: JudgeOutput | null,
  list: MemoryList,
  allowed?: Set<number>,
  fragPools?: Map<number, Set<number>>
): RecallPlanItem[] {
  const out: RecallPlanItem[] = [];
  const seen = new Set<number>();
  const items = Array.isArray(raw?.hits) ? raw.hits : [];

  for (const item of items) {
    const id = Number(item?.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    if (allowed && !allowed.has(id)) continue;
    if (!list.shown.has(id)) continue;

    const level: RecallLevel = item?.level === "core" ? "core" : "related";
    // 模型偶尔照抄清单里的「f91」，去掉前缀再认，认不出就当没指认（不影响事件入选）
    const rawFrag = item?.frag;
    const fragNum = Number(
      typeof rawFrag === "string" ? rawFrag.trim().replace(/^f/i, "") : rawFrag
    );
    const pool = fragPools?.get(id) ?? list.shown.get(id);
    const fragId = Number.isFinite(fragNum) && pool?.has(fragNum) ? fragNum : null;
    seen.add(id);
    out.push({ id, level, fragId });
  }
  return out;
}

/** 超上限截断：core 优先，其次保持模型给的顺序 */
function truncateHits(hits: RecallPlanItem[]): RecallPlanItem[] {
  if (hits.length <= MAX_HITS) return hits;
  return [
    ...hits.filter((h) => h.level === "core"),
    ...hits.filter((h) => h.level === "related"),
  ].slice(0, MAX_HITS);
}

/** 合法且去重后的展开事件编号 */
function normalizeExpand(raw: JudgeOutput | null, list: MemoryList): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of Array.isArray(raw?.expand) ? raw.expand : []) {
    const id = Number(value);
    if (!Number.isFinite(id) || seen.has(id) || !list.shown.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_EXPAND) break;
  }
  return out;
}

/** 一次判定调用的原始返回 */
interface RawCall {
  text: string | null;
  reason?: string;
  usage: LlmUsage | null;
}

/** 用量日志：前缀缓存有没有命中，只能靠这两个数说话 */
function logUsage(label: string, usage: LlmUsage | null): void {
  if (!usage) return;
  logDebug(
    "检索判定用量",
    `${label}：prompt ${usage.promptTokens}（命中缓存 ${usage.cachedTokens}）/ 输出 ${usage.completionTokens}`
  );
}

async function callJudge(messages: { role: "system" | "user"; content: string }[]): Promise<RawCall> {
  // 判定每轮都跑，用单独配置的模型（默认与后台提取相同：便宜、温度 0）
  const config = getModelRouting().retrieval_judge_config;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
  try {
    const client = getClient();
    const response = await client.chat.completions.create(
      {
        model: config.model,
        // 跟随后台路由温度（默认 0）：判定要稳定，不要创意
        temperature: config.temperature,
        response_format: { type: "json_object" },
        messages,
      },
      { signal: controller.signal }
    );
    return {
      text: response.choices[0]?.message?.content ?? null,
      usage: pickUsage(response.usage as RawUsage | undefined),
    };
  } catch (err: unknown) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      text: null,
      reason: aborted ? `${JUDGE_TIMEOUT_MS}ms 超时` : err instanceof Error ? err.message : String(err),
      usage: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 判定结果：ok=false 表示「没判出来」，调用方必须走本地兜底，不能当成零命中 */
export interface JudgeResult {
  ok: boolean;
  hits: RecallPlanItem[];
  /** 两段原始输出（落库复盘用） */
  stage1: string | null;
  stage2: string | null;
  expandUsed: boolean;
  reason?: string;
}

/**
 * 两段判定
 *
 * 第一段给相关事件、档位、指认片段，并声明哪些事件拿不准；
 * 第二段只为这些事件补看最近片段再定档，失败则用第一段结果。
 */
export async function judgeRecall(userText: string, list: MemoryList): Promise<JudgeResult> {
  if (!hasApiKey()) return { ok: false, hits: [], stage1: null, stage2: null, expandUsed: false, reason: "未配置 API Key" };

  const prompts = getPrompts();
  const tail = `## 今天\n${formatTodayLine()}\n\n## 用户说\n${userText}`;

  logRequest(
    `第一段 · 清单 ${list.entries.length} 条 · 用户：${userText.slice(0, 30)}`,
    [
      "## system（判定说明）",
      prompts.retrieval_judge_prompt,
      "",
      "## user（全量清单）",
      list.text,
      "",
      "## user（今天与用户）",
      tail,
    ].join("\n")
  );

  const raw1 = await callJudge([
    { role: "system", content: prompts.retrieval_judge_prompt },
    { role: "user", content: list.text },
    { role: "user", content: tail },
  ]);
  logReturn("第一段", raw1.text, raw1.reason);
  logUsage("第一段", raw1.usage);
  const parsed1 = parseJudgeOutput(raw1.text);
  if (!parsed1) {
    const reason = raw1.reason ?? "第一段输出无法解析";
    logDebug("检索判定", `第一段失败：${reason}\n${(raw1.text ?? "").slice(0, 200)}`);
    return { ok: false, hits: [], stage1: raw1.text, stage2: null, expandUsed: false, reason };
  }

  const hits1 = truncateHits(normalizeHits(parsed1, list));
  const expandIds = normalizeExpand(parsed1, list);
  logDebug(
    "检索判定",
    `清单 ${list.entries.length} 条 / ${list.text.length} 字\n选中: ${hits1.map((h) => `#${h.id}(${h.level}${h.fragId ? ` f${h.fragId}` : ""})`).join("、") || "无"}\n展开: ${expandIds.join("、") || "无"}`
  );

  if (expandIds.length === 0) {
    return { ok: true, hits: hits1, stage1: raw1.text, stage2: null, expandUsed: false };
  }

  // 展开块只拼最后一条 user 消息：前两段完全不变，缓存前缀仍然命中
  const byId = new Map(list.entries.map((e) => [e.event.id, e]));
  /** 第二段可选池：清单两条 ∪ 本次展开的片段（模型看过的都能被指认） */
  const fragPools = new Map<number, Set<number>>();
  const expandBlock = expandIds
    .map((id) => {
      const entry = byId.get(id)!;
      const frags = getRecentFragments(id, 8);
      // 池 = 第一段清单里的两条 ∪ 本次展开的片段（最早那条通常不在最近 8 条里）
      fragPools.set(id, new Set([...(list.shown.get(id) ?? []), ...frags.map((f) => f.id)]));
      const lines = frags.map(
        (f) => `  [f${f.id}] ${renderGist(f.gist, f.timestamp, entry.event.timestamp)}`
      );
      return [`#${id} ${renderLine(entry.event.event_text, entry.event.timestamp)}`, ...lines].join("\n");
    })
    .join("\n\n");

  const stage2Tail = `${tail}\n\n## 要看细节的事件\n${expandBlock}\n\n## 任务\n只对上面这些事件给出最终判定，规则同前，frag 可从上面展开的片段里选；输出 {"hits":[{"id":..,"level":"core|related","frag":..}]}`;
  // 说明与清单与第一段逐字相同，日志只记替换掉的那条，免得把整份清单再写一遍
  logRequest(`第二段 · 展开 ${expandIds.length} 条（说明与清单同第一段）`, stage2Tail);

  const raw2 = await callJudge([
    { role: "system", content: prompts.retrieval_judge_prompt },
    { role: "user", content: list.text },
    { role: "user", content: stage2Tail },
  ]);
  logReturn(`第二段 · 展开 ${expandIds.length} 条`, raw2.text, raw2.reason);
  logUsage("第二段", raw2.usage);
  const parsed2 = parseJudgeOutput(raw2.text);
  if (!parsed2) {
    logDebug("检索判定", `第二段失败，沿用第一段：${raw2.reason ?? "输出无法解析"}`);
    return { ok: true, hits: hits1, stage1: raw1.text, stage2: raw2.text, expandUsed: true, reason: raw2.reason };
  }

  // 第二段对这些事件有最终决定权：第一段里被展开的项一律让位
  const expanded = new Set(expandIds);
  const hits = truncateHits([
    ...hits1.filter((h) => !expanded.has(h.id)),
    ...normalizeHits(parsed2, list, expanded, fragPools),
  ]);
  logDebug(
    "检索判定",
    `二段后选中: ${hits.map((h) => `#${h.id}(${h.level}${h.fragId ? ` f${h.fragId}` : ""})`).join("、") || "无"}`
  );
  return { ok: true, hits, stage1: raw1.text, stage2: raw2.text, expandUsed: true };
}
