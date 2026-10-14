// ============================================================
// 心情动态记忆提取（互动闭环 → 记忆事件，不等巩固流）
//
// 双向进记忆：
// - 用户动态/互动 → 「[user]的心情动态」「和[user]在动态下的互动」（AI 之后记得用户的心情）
// - AI 自身动态 → 「我的心情动态」（存档，供检索时自我引用）
//
// 复用 game/memory.ts 的提取范式：后台模型 JSON mode 提取 gist/summary/keywords，
// insertEpisode 同名事件只建一次、之后追加片段。
// ============================================================

import { getClient } from "@/llm/client";
import { getModelRouting } from "@/prompt/config";
import { stripIdentityKeywords } from "@/memory/identity";
import { ensureTimePlaceholder } from "@/utils/text";
import { logDebug } from "@/store/chatStore";
import {
  insertEpisode,
  getMomentById,
  getMomentComments,
} from "@/db/queries";
import type { Moment, MomentComment } from "@/types/schema";

export interface MomentMemoryExtraction {
  gist: string;
  summary: string;
  /** 检索用关键词（含同义说法） */
  keywords?: string[];
  priority: number;
}

/** 记忆写入场景 */
export type MomentMemoryKind =
  /** 用户发的心情动态本身 */
  | "user_moment"
  /** 动态下的互动闭环（评论/回复来往） */
  | "exchange"
  /** AI 自己发的动态（存档自我引用） */
  | "ai_moment";

const EXTRACT_SYSTEM = `你要把一次「心情动态」（类似朋友圈）里发生的事写成一条记忆。

要求：
1. gist：20 字以内的一句话概要，包含 [user]（用户发的/互动的）或 [ai]（AI 自己发的），只留最核心的印象
2. summary：80~120 字，必须包含 [time] 占位符，并视内容带上 [user]/[ai]。写清三件事：① 谁发了什么/说了什么 ② 关键细节（原话关键词、提到的人事物）③ 当时的情绪与态度。像人真正会记住的那样写，别写成干巴巴的标题
3. keywords: 2~6 个检索用关键词，覆盖关键实体与情绪词，**同时写出同义说法**（如 ["难过","低落","心情不好"]）；不要写用户或你自己的名字/称呼（每条记忆都有，检索无区分度）
4. priority: 1-9（日常流水 3-5，情绪明显波动或重要心事 6-8）

严格输出 JSON：
{"gist":"...","summary":"...","keywords":["..."],"priority":5}`;

function formatMomentLine(m: Moment): string {
  const who = m.author === "ai" ? "[ai]" : "[user]";
  return `${who} 发布（${m.mood || "未标"}）：${m.content}`;
}

/**
 * 提取一条动态（含评论）的记忆内容
 */
async function extractMomentMemory(
  moment: Moment,
  comments: MomentComment[],
  kind: MomentMemoryKind
): Promise<MomentMemoryExtraction | null> {
  const taskText =
    kind === "user_moment"
      ? "只记录这条心情动态本身（用户此刻的心情与心事）"
      : kind === "ai_moment"
        ? "记录你自己发的这条动态（存档，方便以后自我引用）"
        : "记录这次动态互动：动态内容 + 评论区的来往";

  const userPrompt = [
    `## 任务类型`,
    taskText,
    ``,
    `## 动态`,
    formatMomentLine(moment),
    ``,
    `## 评论区`,
    comments.length > 0
      ? comments.map((c) => `${c.author === "ai" ? "[ai]" : "[user]"}：${c.content}`).join("\n")
      : "（没有评论）",
    ``,
    `请输出 JSON。`,
  ].join("\n");

  try {
    const routing = getModelRouting();
    const client = getClient();
    const response = await client.chat.completions.create({
      model: routing.background_extraction_config.model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: userPrompt },
      ],
    });
    const text = response.choices[0]?.message?.content;
    if (!text) return null;

    const parsed = JSON.parse(text) as MomentMemoryExtraction;
    if (!parsed.summary) return null;

    const priority = Number(parsed.priority);
    return {
      // 事发时间写死具体日期的记忆过几天就错了，兜底换回 [time] 占位符
      gist: ensureTimePlaceholder(parsed.gist?.trim() || "") || parsed.summary.slice(0, 24),
      summary: ensureTimePlaceholder(parsed.summary),
      keywords: stripIdentityKeywords(
        (parsed.keywords ?? []).map((k) => String(k).trim()).filter(Boolean)
      ).slice(0, 8),
      priority: Number.isFinite(priority) ? Math.min(9, Math.max(1, priority)) : 5,
    };
  } catch (err) {
    logDebug("动态记忆提取失败", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** 记忆事件标题（同名事件只建一次，之后追加片段） */
function eventTextFor(moment: Moment, kind: MomentMemoryKind): string {
  if (kind === "ai_moment") return "我的心情动态";
  if (moment.author === "ai") return "和[user]在动态下的互动";
  return "[user]的心情动态";
}

/**
 * 写入一条动态记忆（fire-and-forget，失败静默——记忆写丢一条可接受，
 * 不能反过来打扰用户；成功路径：提取 → insertEpisode 挂片段）
 */
async function writeMomentMemory(momentId: number, kind: MomentMemoryKind): Promise<void> {
  const moment = getMomentById(momentId);
  if (!moment) return;
  const comments = getMomentComments(momentId);

  const extraction = await extractMomentMemory(moment, comments, kind);
  if (!extraction) {
    logDebug("动态记忆", `提取为空，跳过: #${momentId}（${kind}）`);
    return;
  }

  insertEpisode(
    eventTextFor(moment, kind),
    extraction.gist,
    extraction.summary,
    extraction.priority,
    (extraction.keywords ?? []).join(",")
  );
  logDebug("动态记忆", `已写入记忆: #${momentId}（${kind}）→ ${extraction.gist}`);
}

/** 用户发帖即记：之后 AI 要记得用户的心情（即使本次没有互动） */
export function recordUserMomentMemory(momentId: number): void {
  writeMomentMemory(momentId, "user_moment").catch((err) =>
    console.error("[moments] 动态记忆写入异常:", err)
  );
}

/** 互动闭环后记：动态 + 评论来往一起计入 */
export function recordMomentExchangeMemory(momentId: number): void {
  writeMomentMemory(momentId, "exchange").catch((err) =>
    console.error("[moments] 动态记忆写入异常:", err)
  );
}

/** AI 自身动态存档：供检索时自我引用 */
export function recordAiMomentMemory(momentId: number): void {
  writeMomentMemory(momentId, "ai_moment").catch((err) =>
    console.error("[moments] 动态记忆写入异常:", err)
  );
}
