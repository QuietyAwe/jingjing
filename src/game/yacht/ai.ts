// ============================================================
// 快艇骰子 AI 决策
//
// AI 自己判断怎么保留骰子、怎么填分（由 LLM 决策），
// 但「分数怎么算」由 rules.ts 精确计算，两者分工：
//   LLM 负责策略，纯函数负责算术，互相校验。
// ============================================================

import { getClient } from "@/llm/client";
import { getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import { stripFence } from "../judge";
import type { YachtSlot, ScoreMap } from "./rules";
import { YACHT_SLOTS, availableSlots, previewScores, totalScore, upperSubtotal } from "./rules";
import { MAX_ROLLS, TOTAL_ROUNDS } from "./engine";

const AI_SYSTEM = `你在和玩家玩「快艇骰子」1v1 对战。你是其中一名玩家，目标是让自己的总分最高。

## 规则（简要）
- 5 个骰子，每轮最多掷 3 次。第一次全掷，之后可以选择保留某些骰子只重掷其余
- 每轮结束后在 13 个计分项里选一项填分
- 上半区（1点~6点）：对应点数之和；上半区合计 ≥63 加 35 分奖励
- 下半区：三条/四条（全部骰子之和）、葫芦（25）、小顺（30）、大顺（40）、快艇（50）、机会（全部之和）

## 策略原则
1. 优先冲高价值项（快艇 50、大顺 40、葫芦 25）
2. 有三条/四条雏形时优先保留
3. 顺子雏形（3 连续以上）值得保留
4. 上半区尽量凑到 63 拿奖励
5. 机会项留作兜底（当没有好选择时）
6. 比分落后时要更激进，领先时要保守

你只需要输出决策，不要解说规则。`;

export interface KeepDecision {
  /** 要保留的骰子下标（0-4） */
  keep: number[];
  reason: string;
}

export interface SlotDecision {
  slot: YachtSlot;
  reason: string;
}

interface CommonParams {
  dice: number[];
  /** 已经用过的计分项 */
  usedSlots: ScoreMap;
  /** 自己的当前总分 */
  myScore: number;
  /** 对手的当前总分 */
  opponentScore: number;
  /** 第几轮（1-13） */
  round: number;
}

function buildCommon(params: CommonParams): string {
  const open = availableSlots(params.usedSlots);
  const preview = previewScores(params.dice, params.usedSlots);
  return [
    `## 当前骰子`,
    params.dice.join(" "),
    ``,
    `## 已用计分项`,
    YACHT_SLOTS.filter((s) => params.usedSlots[s.key] !== undefined)
      .map((s) => `${s.label}=${params.usedSlots[s.key]}`)
      .join("、") || "（无）",
    ``,
    `## 可选项（每项当前能得的分）`,
    open.map((slot) => {
      const label = YACHT_SLOTS.find((s) => s.key === slot)?.label ?? slot;
      return `${label}=${preview[slot]}`;
    }).join("、"),
    ``,
    `## 比分`,
    `我 ${params.myScore} - ${params.opponentScore} 对手`,
    `第 ${params.round}/${TOTAL_ROUNDS} 轮`,
    `上半区当前合计 ${upperSubtotal(params.usedSlots)}（≥63 有 35 分奖励）`,
  ].join("\n");
}

/** AI 决定保留哪些骰子 */
export async function decideKeep(
  params: CommonParams & { rollsLeft: number }
): Promise<KeepDecision | null> {
  const userPrompt = [
    buildCommon(params),
    ``,
    `## 本轮状态`,
    `已掷 ${MAX_ROLLS - params.rollsLeft} 次，还能再掷 ${params.rollsLeft} 次`,
    `请决定保留哪些骰子（下标 0-4，空数组表示全部重掷）。`,
    ``,
    `严格输出 JSON：{"keep":[0,1],"reason":"一句话说明为什么这么留"}`,
  ].join("\n");

  try {
    const routing = getModelRouting();
    const client = getClient();
    const response = await client.chat.completions.create({
      model: routing.background_extraction_config.model,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AI_SYSTEM },
        { role: "user", content: userPrompt },
      ],
    });
    const text = response.choices[0]?.message?.content;
    if (!text) return null;
    const parsed = JSON.parse(stripFence(text)) as KeepDecision;
    const keep = Array.isArray(parsed.keep)
      ? parsed.keep.filter((n) => Number.isInteger(n) && n >= 0 && n < 5)
      : [];
    return { keep, reason: parsed.reason || "" };
  } catch (err) {
    logDebug("快艇决策失败", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** AI 决定填哪一项 */
export async function decideSlot(params: CommonParams): Promise<SlotDecision | null> {
  const userPrompt = [
    buildCommon(params),
    ``,
    `本轮已经掷完，请选择要填分的项（必须是可选项之一）。`,
    `严格输出 JSON：{"slot":"three_of_a_kind","reason":"一句话说明为什么选它"}`,
  ].join("\n");

  try {
    const routing = getModelRouting();
    const client = getClient();
    const response = await client.chat.completions.create({
      model: routing.background_extraction_config.model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AI_SYSTEM },
        { role: "user", content: userPrompt },
      ],
    });
    const text = response.choices[0]?.message?.content;
    if (!text) return null;
    const parsed = JSON.parse(stripFence(text)) as { slot?: YachtSlot; reason?: string };
    const valid = availableSlots(params.usedSlots);
    if (!parsed.slot || !valid.includes(parsed.slot)) {
      // 兜底：选分最高的可选项
      const preview = previewScores(params.dice, params.usedSlots);
      const best = valid.reduce((a, b) => (preview[b] > preview[a] ? b : a), valid[0]);
      return { slot: best, reason: "（自动选择）" };
    }
    return { slot: parsed.slot, reason: parsed.reason || "" };
  } catch (err) {
    logDebug("快艇决策失败", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * 决策失败时的规则兜底：保留点数最多的骰子
 */
export function fallbackKeep(dice: number[]): number[] {
  const counts = new Map<number, number>();
  for (const d of dice) counts.set(d, (counts.get(d) ?? 0) + 1);
  const bestFace = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return dice
    .map((d, i) => (d === bestFace ? i : -1))
    .filter((i) => i >= 0);
}

/** 决策失败时的规则兜底：选当前得分最高的可选项 */
export function fallbackSlot(dice: number[], usedSlots: ScoreMap): YachtSlot {
  const open = availableSlots(usedSlots);
  const preview = previewScores(dice, usedSlots);
  return open.reduce((a, b) => (preview[b] > preview[a] ? b : a), open[0]);
}
