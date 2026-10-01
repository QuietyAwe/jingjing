// ============================================================
// 数字炸弹的对话 Prompt
// AI 的说话（不是猜数决策，见 ai.ts）
// ============================================================

import type { BombState, BombGuess } from "./engine";
import { currentRange } from "./engine";

/** 游戏区（稳定段） */
export function buildBombSection(state: BombState): string {
  const { low, high } = currentRange(state);
  return [
    `## 游戏：数字炸弹（进行中）`,
    `系统随机想了一个 1~100 的数字，你和玩家轮流猜数来缩小范围。`,
    `谁猜中这个数字（炸弹）谁就输。`,
    ``,
    `【当前已知范围】${low} ~ ${high}（炸弹就在里面）`,
    `【已猜过】${state.guesses.map((g) => `${g.player === "user" ? "玩家" : "你"}猜${g.value}${g.result === "high" ? "（大了）" : g.result === "low" ? "（小了）" : "（炸弹）"}`).join("、") || "（无）"}`,
    ``,
    `【要求】`,
    `- 说话要像在玩猜数时的紧张感，可以评价对方猜得准不准、范围越来越小`,
    `- 不要报范围数字（界面已经显示），不要说"还有 X 个可能"`,
    `- 轮到你猜时，用一两句话说说你的猜测，比如"我猜 50！"`,
  ].join("\n");
}

/** AI 猜完后的说话提示（易变段，放历史后） */
export function buildBombActionHint(state: BombState, lastGuess: BombGuess): string {
  const resultText =
    lastGuess.result === "hit"
      ? "💥 猜中了炸弹！"
      : lastGuess.result === "high"
      ? "大了"
      : "小了";
  return [
    `你刚猜了 ${lastGuess.value}，${resultText}`,
    lastGuess.result === "hit"
      ? `你踩到炸弹输了。用你自己的语气认输/懊恼，然后自然地接回日常聊天。`
      : `用一两句话说说你的感受（比如"猜大了，可惜"），然后等玩家继续猜。`,
  ].join("\n");
}

/** 开场提示 */
export function buildBombStartHint(firstPlayer: "user" | "ai"): string {
  return [
    `你刚和玩家开始了一局数字炸弹（系统随机 1~100 的数字，猜中炸弹的输）。`,
    firstPlayer === "user"
      ? `由玩家先猜。用一两句话说说准备好了，可以给个小提示（比如"我猜数字偏小"），然后等玩家猜。`
      : `由你先猜。用一两句话说说准备好了，然后直接说出你猜的数字。`,
  ].join("\n");
}

/** 结束提示 */
export function buildBombEndHint(state: BombState, aiWon: boolean): string {
  return aiWon
    ? `对局结束，你赢了（玩家踩到炸弹）。用你自己的语气宣布胜利，可以小小得意一下，然后接回日常聊天。`
    : `对局结束，你输了（你踩到炸弹）。用你自己的语气认输，可以有点懊恼或开玩笑，然后接回日常聊天。`;
}
