// ============================================================
// 游戏记忆提取（游戏自己的"巩固流"）
//
// 一局结束后，用后台模型从整局流水里提取记忆：
// 既包含谜底与胜负，也包含过程中闲聊透露的内容，
// 因此普通巩固流会跳过游戏回合，避免重复记账。
// ============================================================

import { getClient } from "@/llm/client";
import { getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import type { ConsolidationResponse, GameSession, GameTurn } from "@/types/schema";
import { stripFence } from "./judge";

export interface GameMemoryExtraction {
  summary: string;
  emotion: string;
  priority: number;
  /** 闲聊中透露的新用户信息（增量，可为空对象） */
  new_info?: ConsolidationResponse["new_info"];
}

const EXTRACT_SYSTEM = `你要把一局「20问」游戏写成一条记忆。

要求：
1. summary：50 字以内，必须包含 [user] 和 [time] 占位符，概括这局游戏（谜底、第几次猜中或没猜中）以及过程中闲聊提到的值得一提的内容
2. emotion：描述用户当时的情绪，以及你（AI）想怎么回应，用 [ai] 指代自己
3. priority：这是共同经历，给 7-9（玩得尽兴/猜中给 8-9，平淡给 7）
4. new_info：仅当闲聊中明确透露了新的用户信息时才填（如新增的喜好、人际关系、近况），否则留空对象 {}
   - 不要把游戏问答本身（"是/不是"）当成用户信息
   - 结构与既有画像一致：basic_identity / preferences / social_graph / psycho_state / life_quests

严格输出 JSON：
{"summary":"...","emotion":"...","priority":7,"new_info":{}}`;

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
      summary: parsed.summary,
      emotion: parsed.emotion || "[user]玩得挺开心，[ai]想再和他来一局",
      priority: Number.isFinite(priority) ? Math.min(9, Math.max(7, priority)) : 7,
      new_info: parsed.new_info,
    };
  } catch (err) {
    logDebug("游戏记忆提取失败", err instanceof Error ? err.message : String(err));
    return null;
  }
}
