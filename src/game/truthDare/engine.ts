// ============================================================
// 真心话大冒险：共享题库 + 轮流掷骰抽题
//
// 规则：
// - 题库固定 6 题（用户 3 + AI 3），每题自带「真心话/大冒险」标签
// - 双方轮流掷骰（1~6），掷几抽几，抽到啥玩啥（无胜负，纯陪玩）
// - 题目用完自动重出一批
// ============================================================

export type TruthDareKind = "truth" | "dare";
export type TruthDarePlayer = "user" | "ai";
export type TruthDareAuthor = "user" | "ai" | "system";

export interface TruthDareQuestion {
  /** 题号 1-6，对应骰子点数 */
  index: number;
  kind: TruthDareKind;
  text: string;
  /** 是否已被抽中作答 */
  used: boolean;
  /** 出题方（纯标注，用于「双方各出 3 个」的语义） */
  author: TruthDareAuthor;
  answeredBy?: TruthDarePlayer;
}

export interface TruthDareState {
  questions: TruthDareQuestion[];
  currentPlayer: TruthDarePlayer;
  /** 正在作答的题号（已掷骰），null = 等待掷骰 */
  pendingIndex: number | null;
  /** 已完成回合数 */
  turnCount: number;
  /** 当前第几批题库（用完重出则 +1） */
  round: number;
  finished: boolean;
}

export function createTruthDareState(
  questions: TruthDareQuestion[],
  firstPlayer: TruthDarePlayer = "user"
): TruthDareState {
  return {
    questions,
    currentPlayer: firstPlayer,
    pendingIndex: null,
    turnCount: 0,
    round: 1,
    finished: false,
  };
}

/** 题库是否已用完 */
export function allUsed(state: TruthDareState): boolean {
  return state.questions.every((q) => q.used);
}

/** 随机抽一道未用过的题（返回题号 1-6）；全用完返回 null */
export function pickUnusedQuestion(state: TruthDareState): number | null {
  const unused = state.questions.filter((q) => !q.used);
  if (unused.length === 0) return null;
  return unused[Math.floor(Math.random() * unused.length)].index;
}

/** 掷一枚六面骰，返回点数 1-6 */
export function rollDie(): number {
  return 1 + Math.floor(Math.random() * 6);
}

/**
 * 掷几抽几：点数即题号（题库 6 题与骰面对应）
 * 掷到已用过的题返回 already_used（提示后重掷），题库全用完返回 bank_empty
 */
export function pickByFace(
  state: TruthDareState,
  face: number
): { kind: "question"; index: number } | { kind: "already_used" } | { kind: "bank_empty" } {
  if (state.questions.every((q) => q.used)) return { kind: "bank_empty" };
  const q = state.questions.find((x) => x.index === face);
  return q && !q.used ? { kind: "question", index: face } : { kind: "already_used" };
}

/** 掷骰抽题：把该题标记为当前待作答 */
export function roll(state: TruthDareState, index: number): TruthDareState {
  if (state.finished) return state;
  return {
    ...state,
    pendingIndex: index,
    questions: state.questions.map((q) =>
      q.index === index ? { ...q, used: true, answeredBy: state.currentPlayer } : q
    ),
  };
}

/** 作答完成：清空待答题、切换玩家、回合 +1 */
export function completeTurn(state: TruthDareState): TruthDareState {
  return {
    ...state,
    pendingIndex: null,
    turnCount: state.turnCount + 1,
    currentPlayer: state.currentPlayer === "user" ? "ai" : "user",
  };
}

/**
 * 换一批题库（用完重出 / 用户手动编辑）
 * @param newBatch 是否算「新的一批」（换批时 round +1；用户就地改题不算换批）
 *
 * 待答题保护：掷骰抽出的题已标 used，若这里无条件清 pendingIndex，
 * 该题就永远无法作答也不会被重新抽出（被静默消耗）。
 * 只有当待答题在新题库里仍以 used 状态存在（就地编辑保留了它）才保留 pendingIndex；
 * 整批重出（used 全新）时才丢弃。
 */
export function replaceBank(
  state: TruthDareState,
  questions: TruthDareQuestion[],
  newBatch = true
): TruthDareState {
  const pendingQ =
    state.pendingIndex == null
      ? null
      : questions.find((q) => q.index === state.pendingIndex) ?? null;
  const keepPending = !!pendingQ && pendingQ.used;
  return {
    ...state,
    questions,
    round: newBatch ? state.round + 1 : state.round,
    pendingIndex: keepPending ? state.pendingIndex : null,
  };
}

/** 标记对局结束（退出/收尾时置位并持久化，防止重启恢复后误续跑） */
export function markFinished(state: TruthDareState): TruthDareState {
  return { ...state, finished: true, pendingIndex: null };
}

export function isUserTurn(state: TruthDareState): boolean {
  return !state.finished && state.currentPlayer === "user";
}

/** 当前待作答的题 */
export function pendingQuestion(state: TruthDareState): TruthDareQuestion | null {
  if (state.pendingIndex == null) return null;
  return state.questions.find((q) => q.index === state.pendingIndex) ?? null;
}

/** 剩余未作答题数 */
export function remainingCount(state: TruthDareState): number {
  return state.questions.filter((q) => !q.used).length;
}
