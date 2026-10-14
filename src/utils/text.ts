// ============================================================
// 文本分割工具：聊天气泡的分段规则
//
// 流式阶段与最终气泡必须用同一套规则切割，
// 否则会出现「先一整块显示、完成后突然切成多块」的跳变。
// ============================================================

/**
 * 逐条弹出动画的节奏：一段的显示延迟 = 上一段字数 × 50ms，钳制在 500~3000ms。
 * ChatBubble 的逐条计时与「自动聚焦等待动画播完」共用这一个口径，避免两边漂移。
 */
export function revealStepMs(prevPara: string): number {
  return Math.min(3000, Math.max(500, prevPara.length * 50));
}

/** 整条回复逐条弹出动画的总时长（0 = 无需动画） */
export function revealTotalMs(paragraphs: string[]): number {
  let acc = 0;
  for (let i = 1; i < paragraphs.length; i++) acc += revealStepMs(paragraphs[i - 1]);
  return acc;
}

/** 便捷版：直接按聊天气泡的分段规则算总时长 */
export function revealTotalMsForText(text: string): number {
  return revealTotalMs(splitForChat(text));
}

/**
 * 兜底：把 summary/states 里写死的事发日期换回 [time] 占位符。
 *
 * 提取指令要求事发时间用 [time]（渲染成「昨天/前天」这类相对时间），
 * 但模型看到「当前时间」后有时会直接写「10月10日」——那种日期过几天就成了错误信息。
 * 只在整段完全没有 [time] 时替换第一处时间词，避免动到「约好10月20日见面」
 * 这类关键细节里的未来日期。
 */
export function ensureTimePlaceholder(text: string): string {
  if (!text || text.includes("[time]")) return text;
  return text.replace(
    /(今天|昨天|前天|大前天|\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日)/,
    "[time]"
  );
}

/** 模拟真人聊天风格：按换行分段 + 按句末标点分割 + 去句号 + 长句逗号再拆 */
export function splitForChat(text: string): string[] {
  const LONG_THRESHOLD = 20;
  const result: string[] = [];

  // 1. 先按换行切（连续空行合并，避免产生空白气泡）
  const lines = text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    // 2. 行内按句末标点（。？！～…）再分割，保留问号感叹号等
    for (const seg of line.split(/(?<=[。？！～…])\s*/)) {
      let s = seg.trim();
      if (!s) continue;

      // 3. 去末尾句号（只删句号，保留？！～…）
      s = s.replace(/。+$/, "").trim();
      if (!s) continue;

      // 4. 超过阈值且有逗号 → 按逗号再拆
      if (s.length > LONG_THRESHOLD && s.includes("，")) {
        for (const part of s.split("，")) {
          const p = part.trim();
          if (p) result.push(p);
        }
      } else {
        result.push(s);
      }
    }
  }

  return result;
}
