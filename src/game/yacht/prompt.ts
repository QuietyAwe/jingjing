// ============================================================
// 快艇骰子的对话 Prompt
// 让 AI 在聊天流里自然地谈论这场对局（不是给决策用的，见 ai.ts）
// ============================================================

import type { YachtState } from "./engine";
import { YACHT_SLOTS, totalScore, upperSubtotal, upperBonus } from "./rules";

/**
 * 游戏区（稳定段）：对局信息与 AI 视角
 */
export function buildYachtSection(state: YachtState, ended = false): string {
  return [
    ended ? `## 游戏：快艇骰子 1v1 对战（已结束）` : `## 游戏：快艇骰子 1v1 对战（进行中）`,
    `你和玩家正在玩快艇骰子，各 13 轮，每轮最多掷 3 次、最后在计分卡上选一项填分。`,
    `你和玩家都在争取总分最高。`,
    ``,
    `【当前比分】我 ${totalScore(state.scores.ai)} - ${totalScore(state.scores.user)} 玩家`,
    `【进度】第 ${state.round}/13 轮`,
    ``,
    `【要求】`,
    `- 说话要像在玩骰子时的闲聊，可以评价自己的手气、对方的运气、还差多少分`,
    `- 不要复述规则，不要报每项的分数明细（界面已经显示）`,
    `- 轮到你行动时，用一两句话说说你的打算，比如"我先留一对 6，博个三条"`,
  ].join("\n");
}

/**
 * 本回合 AI 的动作提示（易变段，放在历史之后）
 * 用自然的一段话描述状态并让 AI 解释自己的决策
 */
export function buildYachtActionHint(params: {
  state: YachtState;
  action: "roll" | "keep" | "score";
  dice: number[];
  kept?: number[];
  slot?: string;
  slotValue?: number;
  reason?: string;
  aiName?: string;
  playerLabel?: string;
}): string {
  const { state, action, dice, kept, slot, slotValue, reason } = params;
  const aiName = params.aiName || "对方";
  const playerLabel = params.playerLabel || "玩家";
  const myScore = totalScore(state.scores.ai);
  const userScore = totalScore(state.scores.user);

  if (action === "score") {
    return [
      `你们在进行快艇游戏第 ${state.round} 回合，${aiName}刚投掷出了 ${dice.join(" ")}，选择了「${slot}」，得分 ${slotValue}，当前比分 ${userScore}比${myScore}。`,
      `你最终的骰子是 ${dice.join(" ")}，你选择了「${slot}」，得分 ${slotValue}，用一两句话说说为什么这么选${reason ? `（你的想法是：${reason}）` : ""}，然后交给${playerLabel}行动。`,
    ].join("\n");
  }

  if (action === "keep") {
    return [
      `${aiName}刚投掷出了 ${dice.join(" ")}，决定保留 ${kept && kept.length > 0 ? kept.map((i) => dice[i]).join(" ") : "（全部重掷）"}，当前比分 ${userScore}比${myScore}。`,
      `用一两句话说说你的打算${reason ? `（你的想法是：${reason}）` : ""}，然后继续掷骰。`,
    ].join("\n");
  }

  return `你正在掷骰子，请简短地说说你的手气。`;
}

/**
 * 开场提示：新的一局开始
 * @param firstPlayer 谁先掷（先后手随机，别让 AI 说错）
 */
export function buildYachtStartHint(firstPlayer: "user" | "ai" = "user"): string {
  return [
    `你刚和玩家开始了一局快艇骰子 1v1 对战（13 轮）。`,
    `规则玩家已经看到了，你不要重复规则。`,
    `只说一两句简短的话表示开始，可以提一下自己的手气、或者打个招呼，然后${
      firstPlayer === "user" ? "等玩家先掷。" : "你先掷骰子。"
    }`,
  ].join("\n");
}

/**
 * 结束提示：宣布结果
 */
export function buildYachtEndHint(state: YachtState): string {
  const myScore = totalScore(state.scores.ai);
  const userScore = totalScore(state.scores.user);
  const result =
    state.winner === "user"
      ? `你以 ${userScore} : ${myScore} 输给了玩家`
      : state.winner === "ai"
      ? `你以 ${myScore} : ${userScore} 赢了玩家`
      : `你和玩家打成 ${myScore} 平手`;
  return [
    `对局结束：${result}。`,
    `用你自己的语气宣布结果（开心/不服气/惋惜都可以），`,
    `可以提一下这局亮点（比如某个大顺、快艇），然后自然地接回日常聊天。`,
  ].join("\n");
}

/**
 * 中途退出提示：收尾告别
 */
export function buildYachtQuitHint(state: YachtState): string {
  const myScore = totalScore(state.scores.ai);
  const userScore = totalScore(state.scores.user);
  return [
    `玩家中途退出了这局快艇骰子，当时比分 ${userScore} : ${myScore}（玩家 : 你）。`,
    `用你的语气说一两句收尾告别的话（比如下次再战），不要报分数明细，然后自然地接回日常聊天。`,
  ].join("\n");
}

/** 渲染计分卡（给 UI 展示用） */
export function renderScoreCard(state: YachtState): {
  label: string;
  section: string;
  user: number | null;
  ai: number | null;
}[] {
  return YACHT_SLOTS.map((s) => ({
    label: s.label,
    section: s.section,
    user: state.scores.user[s.key] ?? null,
    ai: state.scores.ai[s.key] ?? null,
  }));
}

/** 上半区汇总（给 UI 显示） */
export function getUpperSummary(state: YachtState): { user: number; bonus: number; ai: number } {
  return {
    user: upperSubtotal(state.scores.user),
    bonus: upperBonus(state.scores.user),
    ai: upperSubtotal(state.scores.ai),
  };
}
