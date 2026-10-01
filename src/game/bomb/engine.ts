// ============================================================
// 数字炸弹：系统随机 1~100 一个数字，双方轮流猜数缩小范围
// 猜中炸弹的输。先后手随机。
// ============================================================

export type BombPlayer = "user" | "ai";

export interface BombGuess {
  player: BombPlayer;
  value: number;
  /** high = 猜大了，low = 猜小了，hit = 猜中炸弹 */
  result: "high" | "low" | "hit";
}

export interface BombState {
  /** 炸弹数字（1-100，对 UI 隐藏） */
  bomb: number;
  currentPlayer: BombPlayer;
  /** 当前已知区间（不含端点） */
  min: number;
  max: number;
  guesses: BombGuess[];
  finished: boolean;
  winner: BombPlayer | null;
}

export function createBombState(): BombState {
  return {
    bomb: Math.floor(Math.random() * 100) + 1,
    // 先后手随机
    currentPlayer: Math.random() < 0.5 ? "user" : "ai",
    min: 0,
    max: 101,
    guesses: [],
    finished: false,
    winner: null,
  };
}

/** 猜一个数：更新范围、判断胜负、切换玩家 */
export function guess(state: BombState, value: number): BombState {
  if (state.finished) return state;
  const clamped = Math.max(1, Math.min(100, Math.floor(value)));
  const result: BombGuess["result"] =
    clamped === state.bomb ? "hit" : clamped > state.bomb ? "high" : "low";

  const guesses = [...state.guesses, { player: state.currentPlayer, value: clamped, result }];
  const finished = result === "hit";

  // 收窄区间
  const min = result === "low" ? Math.max(state.min, clamped) : state.min;
  const max = result === "high" ? Math.min(state.max, clamped) : state.max;

  return {
    ...state,
    guesses,
    min,
    max,
    finished,
    // 猜中炸弹的输，对方赢
    winner: finished ? (state.currentPlayer === "user" ? "ai" : "user") : null,
    currentPlayer: finished
      ? state.currentPlayer
      : state.currentPlayer === "user"
      ? "ai"
      : "user",
  };
}

/** 当前可猜的范围（不含端点） */
export function currentRange(state: BombState): { low: number; high: number } {
  return { low: state.min + 1, high: state.max - 1 };
}

/** 是否轮到用户 */
export function isUserTurn(state: BombState): boolean {
  return !state.finished && state.currentPlayer === "user";
}

/** 该数字是否已经猜过 */
export function alreadyGuessed(state: BombState, value: number): boolean {
  return state.guesses.some((g) => g.value === value);
}
