// ============================================================
// 快艇骰子（Yacht）状态机
// 纯函数更新状态，不依赖 LLM
// ============================================================

import type { YachtSlot, ScoreMap } from "./rules";
import { availableSlots, totalScore, calculateScore } from "./rules";

export type YachtPlayer = "user" | "ai";

export interface YachtState {
  /** 1-13 轮 */
  round: number;
  currentPlayer: YachtPlayer;
  /** 本轮已掷次数（1-3） */
  rolls: number;
  /** 当前 5 个骰子的点数 */
  dice: number[];
  /** 每个骰子是否锁定（保留） */
  kept: boolean[];
  scores: Record<YachtPlayer, ScoreMap>;
  finished: boolean;
  winner: YachtPlayer | "tie" | null;
}

const DICE_COUNT = 5;
export const MAX_ROLLS = 3;
export const TOTAL_ROUNDS = 13;

function randomDie(): number {
  return Math.floor(Math.random() * 6) + 1;
}

export function createYachtState(): YachtState {
  return {
    round: 1,
    // 先后手随机
    currentPlayer: Math.random() < 0.5 ? "user" : "ai",
    rolls: 0,
    dice: Array.from({ length: DICE_COUNT }, randomDie),
    kept: Array.from({ length: DICE_COUNT }, () => false),
    scores: { user: {}, ai: {} },
    finished: false,
    winner: null,
  };
}

/** 掷骰：只掷未锁定的，掷次数 +1 */
export function roll(state: YachtState): YachtState {
  if (state.rolls >= MAX_ROLLS) return state;
  const dice = state.dice.map((d, i) => (state.kept[i] ? d : randomDie()));
  return {
    ...state,
    dice,
    rolls: state.rolls + 1,
  };
}

/** 切换某个骰子的锁定状态 */
export function toggleKeep(state: YachtState, index: number): YachtState {
  const kept = [...state.kept];
  kept[index] = !kept[index];
  return { ...state, kept };
}

/** 只保留指定下标的骰子（AI 决策用） */
export function applyKeep(state: YachtState, keepIndices: number[]): YachtState {
  const kept = Array.from({ length: DICE_COUNT }, (_, i) => keepIndices.includes(i));
  return { ...state, kept };
}

/** 填分：记录得分、切换玩家、推进轮次 */
export function score(state: YachtState, slot: YachtSlot): YachtState {
  const player = state.currentPlayer;
  const value = calculateScore(state.dice, slot);
  const scores = {
    ...state.scores,
    [player]: { ...state.scores[player], [slot]: value },
  };

  // AI 先手的话判断轮次是否结束
  const nextPlayer: YachtPlayer = player === "user" ? "ai" : "user";
  const roundAdvanced = player === "ai";
  const round = roundAdvanced ? state.round + 1 : state.round;
  const finished = round > TOTAL_ROUNDS;

  const winner = finished
    ? totalScore(scores.user) > totalScore(scores.ai)
      ? "user"
      : totalScore(scores.user) < totalScore(scores.ai)
      ? "ai"
      : "tie"
    : null;

  return {
    ...state,
    scores,
    currentPlayer: nextPlayer,
    round: finished ? TOTAL_ROUNDS : round,
    rolls: 0,
    dice: Array.from({ length: DICE_COUNT }, randomDie),
    kept: Array.from({ length: DICE_COUNT }, () => false),
    finished,
    winner,
  };
}

/** 当前玩家还能选的项目 */
export function openSlots(state: YachtState): YachtSlot[] {
  return availableSlots(state.scores[state.currentPlayer]);
}

/** 该玩家是否还可以继续掷（< 3 次） */
export function canRoll(state: YachtState): boolean {
  return !state.finished && state.rolls < MAX_ROLLS;
}
