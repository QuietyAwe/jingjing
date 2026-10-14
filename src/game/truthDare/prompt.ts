// ============================================================
// 真心话大冒险的对话 Prompt
// AI 的说话（不是游戏判定，见 engine.ts）
// ============================================================

import type { TruthDareState, TruthDareQuestion } from "./engine";
import { pendingQuestion, remainingCount } from "./engine";

export const KIND_LABEL: Record<TruthDareQuestion["kind"], string> = {
  truth: "真心话",
  dare: "大冒险",
};

/** 游戏区（稳定段） */
export function buildTruthDareSection(state: TruthDareState, ended = false): string {
  const bankLines = state.questions.map((q) => {
    const mark = q.used ? "✓已答" : "·未抽";
    return `${q.index}.「${KIND_LABEL[q.kind]}」${q.text}（${mark}）`;
  });
  return [
    ended ? `## 游戏：真心话大冒险（已结束）` : `## 游戏：真心话大冒险（进行中）`,
    `你和玩家轮流掷骰子（1~6）抽题，抽到哪题就答哪题。`,
    `题目分「真心话」（走心回答）和「大冒险」（文字即可完成的俏皮挑战）。`,
    `没有输赢，就是互相了解、增进感情，随时可以停。`,
    ``,
    `【当前题库（第 ${state.round} 批）】`,
    ...bankLines,
    ``,
    `【剩余 ${remainingCount(state)} 题未答】`,
    `【要求】`,
    `- 轮到你答题时，真诚、自然、带点温度，就像在和朋友玩，不要像答题机器`,
    `- 可以先对玩家刚才的回答说句反应，再答你自己的题`,
    `- 大冒险就用文字俏皮地「完成」它（比如让撒娇就真的撒个娇）`,
  ].join("\n");
}

/** AI 答自己那题的提示（易变段） */
export function buildTruthDareAnswerHint(params: {
  question: TruthDareQuestion;
  aiName: string;
  playerLabel: string;
}): string {
  const { question, aiName, playerLabel } = params;
  const kind = KIND_LABEL[question.kind];
  return [
    `轮到你（${aiName}）了，你掷骰抽到 ${question.index} 号题，是「${kind}」：${question.text}`,
    question.kind === "truth"
      ? `请用你自己的语气真诚回答这道真心话，可以反问玩家一句互动。`
      : `这是一道大冒险，请用文字俏皮地「完成」它（真的去做这个表达，而不是描述）。`,
    `答完可以自然地示意轮到${playerLabel}了。`,
  ].join("\n");
}

/** 用户答完后，AI 反应 + 接自己回合（合成一条） */
export function buildTruthDareReactAndAnswerHint(params: {
  question: TruthDareQuestion;
  userAnswer: string;
  aiName: string;
  playerLabel: string;
}): string {
  const { question, userAnswer, aiName, playerLabel } = params;
  const kind = KIND_LABEL[question.kind];
  return [
    `玩家「${playerLabel}」刚回答了：${userAnswer}`,
    `先用一两句话对他的回答给点反应（共情、共鸣或打趣）。`,
    ``,
    `然后轮到你（${aiName}）掷骰，你抽到 ${question.index} 号题「${kind}」：${question.text}`,
    question.kind === "truth"
      ? `真诚回答这道真心话。`
      : `用文字俏皮地「完成」这道大冒险。`,
    `答完示意轮到${playerLabel}了。`,
  ].join("\n");
}

/** 开场提示 */
export function buildTruthDareStartHint(firstPlayer: "user" | "ai"): string {
  return [
    `你刚和玩家开始了一局真心话大冒险（轮流掷骰抽题，答真心话或做大冒险，无胜负）。`,
    firstPlayer === "user"
      ? `由玩家先掷骰。用一两句热情又俏皮的话开场，说说规则、期待他的答案，然后等他掷骰。`
      : `由你先掷骰。用一两句俏皮话开场，然后直接答你抽到的那题。`,
  ].join("\n");
}

/** 结束提示 */
export function buildTruthDareEndHint(): string {
  return `真心话大冒险告一段落了。用你自己的语气说说玩得开心、谢谢对方坦诚，然后自然接回日常聊天。`;
}
