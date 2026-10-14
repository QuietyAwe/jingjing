// ============================================================
// 数字炸弹 AI 猜数策略
//
// 纯规则（二分法 + 少量随机），不走 LLM：
// 数字炸弹是纯数学游戏，二分法最优，LLM 反而慢且可能犯错。
// AI 的「说话」由 prompt.ts 驱动，走前台模型。
// ============================================================

import type { BombState } from "./engine";
import { currentRange, alreadyGuessed } from "./engine";

/**
 * AI 猜一个数
 * 策略：80% 二分（逼近炸弹），20% 在区间内随机（让它像人，不是算得太准）
 */
/** 在 [low, high] 内挑一个没猜过的数（中点优先），全都猜过才回退中点 */
function pickUntried(state: BombState, low: number, high: number): number {
  const mid = Math.floor((low + high) / 2);
  if (!alreadyGuessed(state, mid)) return mid;
  for (let v = low; v <= high; v++) {
    if (!alreadyGuessed(state, v)) return v;
  }
  return mid;
}

export function aiGuess(state: BombState): number {
  const { low, high } = currentRange(state);
  if (low >= high) return Math.max(1, low);

  const mid = Math.floor((low + high) / 2);
  if (Math.random() < 0.2) {
    // 随机扰动：在区间里找一个没猜过的数
    for (let i = 0; i < 5; i++) {
      const r = Math.floor(Math.random() * (high - low + 1)) + low;
      if (!alreadyGuessed(state, r)) return r;
    }
  }

  // 中点已经猜过就顺延找下一个没猜过的（旧偏移 mid±1 也可能撞上已猜过的数，白费一轮）
  return pickUntried(state, low, high);
}
