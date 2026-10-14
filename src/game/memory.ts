// ============================================================
// 游戏记忆提取（游戏自己的"巩固流"）
//
// 一局结束后，用后台模型从整局流水里提取记忆：
// 既包含谜底与胜负，也包含过程中闲聊透露的内容，
// 因此普通巩固流会跳过游戏回合，避免重复记账。
// ============================================================

import { getClient } from "@/llm/client";
import { getModelRouting } from "@/prompt/config";
import { stripIdentityKeywords } from "@/memory/identity";
import { ensureTimePlaceholder } from "@/utils/text";
import { logDebug } from "@/store/chatStore";
import type { ConsolidationResponse, GameSession, GameTurn } from "@/types/schema";
import { stripFence } from "./judge";

export interface GameMemoryExtraction {
  gist: string;
  summary: string;
  /** 检索用关键词（含同义说法） */
  keywords?: string[];
  priority: number;
  /** 闲聊中透露的新用户信息（增量，可为空对象） */
  new_info?: ConsolidationResponse["new_info"];
}

const EXTRACT_SYSTEM = `你要把一局「20问」游戏写成一条记忆。

要求：
1. gist：20 字以内的一句话概要，必须包含 [user]，只留最核心的印象
2. summary：80~120 字，必须包含 [user] 和 [time] 占位符。概括这局游戏（谜底、第几次猜中或没猜中）、过程中闲聊提到的值得一提的内容，以及 [user] 当时的情绪与反应；提到自己时用 [ai] 指代
3. keywords: 2~6 个检索用关键词，覆盖关键实体（他人姓名、地名、事物、概念），同时写出同义说法；不要写用户或你自己的名字/称呼（每条记忆都有，检索无区分度）
4. priority：这是共同经历，给 7-9（玩得尽兴/猜中给 8-9，平淡给 7）
5. new_info：仅当闲聊中明确透露了新的用户信息时才填，否则留空对象 {}
   - 不要把游戏问答本身（"是/不是"）当成用户信息
   - 结构与既有画像一致（属性/状态/事件 三桶）：basic_identity / social_graph / traits(永久属性) / states(有时效的近况，文本带[time]) / events({text, due_time}，有明确时间的约定)

严格输出 JSON：
{"gist":"...","summary":"...","keywords":["..."],"priority":7,"new_info":{}}`;

/**
 * 从一局游戏里提取记忆内容
 */
export async function extractGameMemory(
  session: GameSession,
  turns: GameTurn[],
  outcome: "won" | "lost"
): Promise<GameMemoryExtraction | null> {
  if (turns.length === 0) return null;

  const lines = turns.map((t) => {
    if (t.intent === "question") {
      return `玩家问：${t.text} → ${t.answer === "yes" ? "是" : t.answer === "no" ? "不是" : "不好说"}`;
    }
    if (t.intent === "guess") {
      return `玩家猜：${t.guess ?? t.text} → ${t.correct ? "猜中了" : "没猜中"}`;
    }
    return `闲聊：${t.text}`;
  });

  const userPrompt = [
    `## 本局信息`,
    `谜底：${session.secret}（题材来源：${session.secret_source === "memory" ? "共同记忆" : "公共题材"}）`,
    `结果：${outcome === "won" ? "玩家猜中了" : "玩家没猜中"}`,
    `提问次数：${session.question_count}`,
    ``,
    `## 整局流水`,
    lines.join("\n"),
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

    const parsed = JSON.parse(stripFence(text)) as GameMemoryExtraction;
    if (!parsed.summary) return null;

    const priority = Number(parsed.priority);
    return {
      // 事发时间写死具体日期的记忆过几天就错了，兜底换回 [time] 占位符
      gist: ensureTimePlaceholder(parsed.gist?.trim() || "") || parsed.summary.slice(0, 24),
      summary: ensureTimePlaceholder(parsed.summary),
      keywords: stripIdentityKeywords(
        (parsed.keywords ?? []).map((k) => String(k).trim()).filter(Boolean)
      ).slice(0, 8),
      priority: Number.isFinite(priority) ? Math.min(9, Math.max(7, priority)) : 7,
      new_info: parsed.new_info,
    };
  } catch (err) {
    logDebug("游戏记忆提取失败", err instanceof Error ? err.message : String(err));
    return null;
  }
}
