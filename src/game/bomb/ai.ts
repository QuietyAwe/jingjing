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
    return mid;
  }

  // 中点如果已经猜过，稍微偏移
  if (alreadyGuessed(state, mid)) {
    return mid + 1 <= high ? mid + 1 : mid - 1;
  }
  return mid;
}
