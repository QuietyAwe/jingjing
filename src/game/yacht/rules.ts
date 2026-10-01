// ============================================================
// 快艇骰子（Yacht）计分规则
// 纯函数，不含任何 LLM 依赖——分数必须精确，不能靠模型心算
// ============================================================

export type YachtSlot =
  | "aces"
  | "twos"
  | "threes"
  | "fours"
  | "fives"
  | "sixes"
  | "three_of_a_kind"
  | "four_of_a_kind"
  | "full_house"
  | "small_straight"
  | "large_straight"
  | "yahtzee"
  | "chance";

export const YACHT_SLOTS: { key: YachtSlot; label: string; section: "upper" | "lower" }[] = [
  { key: "aces", label: "1点", section: "upper" },
  { key: "twos", label: "2点", section: "upper" },
  { key: "threes", label: "3点", section: "upper" },
  { key: "fours", label: "4点", section: "upper" },
  { key: "fives", label: "5点", section: "upper" },
  { key: "sixes", label: "6点", section: "upper" },
  { key: "three_of_a_kind", label: "三条", section: "lower" },
  { key: "four_of_a_kind", label: "四条", section: "lower" },
  { key: "full_house", label: "葫芦", section: "lower" },
  { key: "small_straight", label: "小顺", section: "lower" },
  { key: "large_straight", label: "大顺", section: "lower" },
  { key: "yahtzee", label: "快艇", section: "lower" },
  { key: "chance", label: "机会", section: "lower" },
];

export const UPPER_BONUS_THRESHOLD = 63;
export const UPPER_BONUS = 35;

export type ScoreMap = Partial<Record<YachtSlot, number>>;

function sum(dice: number[]): number {
  return dice.reduce((a, b) => a + b, 0);
}

/** 统计各点数出现次数 */
function countByFace(dice: number[]): Record<number, number> {
  const m: Record<number, number> = {};
  for (const d of dice) m[d] = (m[d] || 0) + 1;
  return m;
}

/** 是否包含顺子（长度 >= len 的连续数字） */
function hasStraight(dice: number[], len: number): boolean {
  const uniq = [...new Set(dice)].sort((a, b) => a - b);
  let run = 1;
  for (let i = 1; i < uniq.length; i++) {
    if (uniq[i] === uniq[i - 1] + 1) {
      run++;
      if (run >= len) return true;
    } else {
      run = 1;
    }
  }
  return len === 1; // 单张永远成立（用于上半区数字项）
}

/**
 * 计算某项得分
 * @returns 该选项得分（可为 0，例如三条不成立但选择填 0）
 */
export function calculateScore(dice: number[], slot: YachtSlot): number {
  const faces = countByFace(dice);
  const counts = Object.values(faces);

  switch (slot) {
    case "aces":
      return dice.filter((d) => d === 1).length * 1;
    case "twos":
      return dice.filter((d) => d === 2).length * 2;
    case "threes":
      return dice.filter((d) => d === 3).length * 3;
    case "fours":
      return dice.filter((d) => d === 4).length * 4;
    case "fives":
      return dice.filter((d) => d === 5).length * 5;
    case "sixes":
      return dice.filter((d) => d === 6).length * 6;
    case "three_of_a_kind":
      return counts.some((c) => c >= 3) ? sum(dice) : 0;
    case "four_of_a_kind":
      return counts.some((c) => c >= 4) ? sum(dice) : 0;
    case "full_house":
      return counts.includes(3) && counts.includes(2) ? 25 : 0;
    case "small_straight":
      return hasStraight(dice, 4) ? 30 : 0;
    case "large_straight":
      return hasStraight(dice, 5) ? 40 : 0;
    case "yahtzee":
      return counts.some((c) => c >= 5) ? 50 : 0;
    case "chance":
      return sum(dice);
    default:
      return 0;
  }
}

/** 上半区合计与奖励 */
export function upperSubtotal(scores: ScoreMap): number {
  const keys: YachtSlot[] = ["aces", "twos", "threes", "fours", "fives", "sixes"];
  return keys.reduce((acc, k) => acc + (scores[k] ?? 0), 0);
}

export function upperBonus(scores: ScoreMap): number {
  return upperSubtotal(scores) >= UPPER_BONUS_THRESHOLD ? UPPER_BONUS : 0;
}

/** 总分（含奖励） */
export function totalScore(scores: ScoreMap): number {
  const lower = YACHT_SLOTS.filter((s) => s.section === "lower")
    .map((s) => s.key)
    .reduce((acc, k) => acc + (scores[k] ?? 0), 0);
  return upperSubtotal(scores) + upperBonus(scores) + lower;
}

/** 该玩家还剩哪些可选项 */
export function availableSlots(scores: ScoreMap): YachtSlot[] {
  return YACHT_SLOTS.map((s) => s.key).filter((k) => scores[k] === undefined);
}

/**
 * 预览每个可选项的得分，用于 UI 提示与 AI 决策
 * @returns Map<slot, score>
 */
export function previewScores(dice: number[], scores: ScoreMap): Record<YachtSlot, number> {
  const out = {} as Record<YachtSlot, number>;
  for (const slot of availableSlots(scores)) {
    out[slot] = calculateScore(dice, slot);
  }
  return out;
}
