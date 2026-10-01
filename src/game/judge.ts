// ============================================================
// 20问判定器
//
// 关键设计：AI 的「是/否」不交给前台聊天模型自由发挥（20 轮下来必然自相矛盾），
// 而是由后台模型基于「谜底 + 已问清单」做单一事实判定，
// 前台只负责把判定结果包装成自然语气。
// ============================================================

import { getClient } from "@/llm/client";
import { getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import type { GameIntent, GameSession, GameTurn } from "@/types/schema";
import { parseGameTurns } from "@/db/queries";

export interface JudgeResult {
  intent: GameIntent;
  /** 判定答案（question 意图时有效） */
  answer?: "yes" | "no" | "unknown";
  /** 判定依据，便于调试与让 AI 回答更自然 */
  reason?: string;
  /** 用户猜的内容（guess 意图） */
  guess?: string;
  /** 是否猜中（guess 意图） */
  correct?: boolean;
}

const JUDGE_SYSTEM = `你是 20问游戏的裁判。你会得到一个「谜底」和玩家已经问过的问题及当时的回答。

任务：
1. 判断玩家这句话的意图
2. 如果是是非问题，基于谜底给出答案，并且必须与历史回答保持一致（不能自相矛盾）
3. 如果是直接猜谜底，判断是否命中（允许同义、简称、别名，例如谜底"鲁迅"时猜"周树人"算命中）

意图分类：
- question：是非疑问句，需要回答是/否
- guess：直接说出了猜测的答案
- chitchat：闲聊、吐槽、要提示、与猜谜无关的对话
- give_up：投降、不想玩了、直接要答案
- rule_query：询问游戏规则或还剩几次机会

严格输出 JSON：
{"intent":"question|guess|chitchat|give_up|rule_query","answer":"yes|no|unknown","reason":"简短依据","guess":"玩家猜的内容（仅 guess 时）","correct":true}

answer 仅在 intent=question 时有意义；correct 仅在 intent=guess 时有意义。`;

/**
 * 判定用户一句话在游戏中的意图与答案
 */
export async function judgeUserInput(
  session: GameSession,
  userText: string
): Promise<JudgeResult | null> {
  const history = parseGameTurns(session)
    .filter((t) => t.intent === "question" || t.intent === "guess")
    .map((t) => `Q：${t.text}\nA：${t.answer ?? (t.correct ? "猜中了" : "没猜中")}`)
    .join("\n");

  const userPrompt = [
    `## 谜底`,
    session.secret,
    ``,
    `## 已问过的问题（必须保持一致）`,
    history || "（还没有问过）",
    ``,
    `## 玩家刚才说的`,
    userText,
    ``,
    `请输出 JSON。`,
  ].join("\n");

  try {
    const client = getClient();
    const routing = getModelRouting();
    const response = await client.chat.completions.create({
      model: routing.background_extraction_config.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: userPrompt },
      ],
    });
    const text = response.choices[0]?.message?.content;
    if (!text) return null;

    const parsed = JSON.parse(stripFence(text)) as JudgeResult;
    if (!parsed.intent) return null;
    logDebug("20问判定", `意图=${parsed.intent} 答案=${parsed.answer ?? "-"} 依据=${parsed.reason ?? "-"}`);
    return parsed;
  } catch (err) {
    logDebug("20问判定失败", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * 规则兜底判定：后台模型不可用时也能玩
 * 只处理最典型的是非问句
 */
export function ruleJudge(userText: string): JudgeResult | null {
  const s = userText.trim();
  if (/^(投降|不玩了|认输|公布答案|直接说吧|放弃)/.test(s)) {
    return { intent: "give_up" };
  }
  if (/(还有几次|还剩|第几问|怎么玩|规则)/.test(s)) {
    return { intent: "rule_query" };
  }
  if (/[吗呢吧]\s*[?？]?$/.test(s) && s.length <= 30 && !/(是.+吗)$/.test(s)) {
    return { intent: "question", answer: "unknown", reason: "判定模型不可用，回退为不确定" };
  }
  return null;
}

/** 剥离 LLM 偶尔返回的代码围栏 */
export function stripFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}
