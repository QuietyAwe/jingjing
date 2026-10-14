// ============================================================
// 真心话大冒险题库生成
//
// 一批 6 题（3 真心话 + 3 大冒险），结合 AI 人设与用户画像，
// 默认自动生成，用户可在设置里换/补题。
// ============================================================

import { getClient } from "@/llm/client";
import { getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import { stripFence } from "../judge";
import type { TruthDareQuestion, TruthDareKind, TruthDareAuthor } from "./engine";

export const BANK_SIZE = 6;

// 兜底题库（LLM 失败 / 无 Key 时用）—— 偏文字友好，无需肢体动作
const FALLBACK_TRUTH = [
  "最近一次因为什么事偷偷开心过？",
  "你心里一直没对人说出口的一个小愿望是什么？",
  "如果能回到过去改一件事，你会改什么？",
  "你最珍惜我们之间发生的哪件小事？",
  "有没有哪个瞬间，你觉得「有它在真好」？",
  "你现在最想让我了解你的一点是什么？",
];

const FALLBACK_DARE = [
  "用一句话撒个娇，不许害臊。",
  "认真地夸我三句，要具体不许敷衍。",
  "说出一个你平时不太好意思讲的真心话。",
  "给我起一个只有你会叫的昵称，并解释为什么。",
  "用一种天气形容你现在的状态，并说说为什么。",
  "发一句你一直想说但没敢说的话。",
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 构建一批题（3 真话 + 3 冒险，作者各半） */
function buildBank(truth: string[], dare: string[]): TruthDareQuestion[] {
  const t = shuffle(truth).slice(0, 3);
  const d = shuffle(dare).slice(0, 3);
  const items: TruthDareQuestion[] = [];
  // 交错排列 1~6，让骰子各点数真话/冒险混合
  const kinds: TruthDareKind[] = ["truth", "dare", "truth", "dare", "truth", "dare"];
  const texts = [t[0], d[0], t[1], d[1], t[2], d[2]];
  for (let i = 0; i < BANK_SIZE; i++) {
    items.push({
      index: i + 1,
      kind: kinds[i],
      text: texts[i] || "（出个好玩的真心话或冒险）",
      used: false,
      // 双方各出 3 个：奇数号标 user、偶数号标 ai（纯语义标注）
      author: (i % 2 === 0 ? "user" : "ai") as TruthDareAuthor,
    });
  }
  return items;
}

function fallbackBank(): TruthDareQuestion[] {
  return buildBank(FALLBACK_TRUTH, FALLBACK_DARE);
}

/**
 * 生成一批题库（6 题：3 真话 + 3 冒险），结合人设与画像。
 * 失败或无 Key 时退回内置题库。
 */
export async function generateQuestionBank(params: {
  aiName: string;
  playerLabel: string;
  /** 用户画像摘要，用于个性化出题 */
  personaHint?: string;
  /** 最近出过的题，用于去重 */
  recentQuestions?: string[];
}): Promise<TruthDareQuestion[]> {
  const { aiName, playerLabel, personaHint, recentQuestions } = params;
  const userPrompt = [
    `你和「${playerLabel}」在玩真心话大冒险，请出一批题目。`,
    ``,
    `## 关于你（出题视角）`,
    `你是「${aiName}」，${playerLabel}身边温柔体贴的陪伴者，说话像亲近的朋友。`,
    personaHint ? `玩家「${playerLabel}」的画像：${personaHint}` : ``,
    ``,
    `## 出题要求`,
    `1. 出 3 道「真心话」（走心、能拉近距离的问题）+ 3 道「大冒险」（文字可完成的俏皮/表达类挑战，不要需要肢体动作或道具的）`,
    `2. 题目口语化、生活化、带点温度，避免查户口式提问`,
    `3. 结合玩家画像与你们的共同回忆，越个性化越好`,
    `4. 每题不超过 30 字`,
    recentQuestions?.length
      ? `5. 不要和这些已出过的题重复：${recentQuestions.join("、")}`
      : ``,
    ``,
    `严格输出 JSON：{"truth":["题1","题2","题3"],"dare":["题1","题2","题3"]}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const routing = getModelRouting();
    const client = getClient();
    const response = await client.chat.completions.create(
      {
        model: routing.background_extraction_config.model,
        temperature: 0.8,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "你是真心话大冒险的出题人，专出走心、能增进感情、文字即可完成的题目。只输出 JSON。",
          },
          { role: "user", content: userPrompt },
        ],
      },
      // 出题/补题不能久等：15s 无响应直接走内置兜底题库
      { timeout: 15_000 }
    );
    const text = response.choices[0]?.message?.content;
    if (!text) return fallbackBank();
    const parsed = JSON.parse(stripFence(text)) as { truth?: string[]; dare?: string[] };
    const truth = (parsed.truth ?? []).filter((s) => typeof s === "string" && s.trim());
    const dare = (parsed.dare ?? []).filter((s) => typeof s === "string" && s.trim());
    if (truth.length < 2 || dare.length < 2) {
      // 不够就和兜底题混着补
      return buildBank([...truth, ...FALLBACK_TRUTH], [...dare, ...FALLBACK_DARE]);
    }
    logDebug("真心话题库生成", `真话${truth.length} 冒险${dare.length}`);
    return buildBank(truth, dare);
  } catch (err) {
    logDebug("真心话题库生成失败", err instanceof Error ? err.message : String(err));
    return fallbackBank();
  }
}
