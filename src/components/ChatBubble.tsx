// ============================================================
// 聊天气泡组件 — 深色气泡(用户) / 浅灰气泡(AI)
// 长按触发 onLongPress 回调
// ============================================================

import { View, Text, StyleSheet, Pressable } from "react-native";
import type { ChatMessage } from "@/types/schema";
import { useTheme, useCurrentCustomColors } from "@/theme/useTheme";
import { useState, useMemo, useEffect, useRef } from "react";

/** 模拟真人聊天风格：按句末标点分割 + 去句号 + 长句逗号再拆 */
function splitForChat(text: string): string[] {
  const LONG_THRESHOLD = 20;
  const result: string[] = [];

  // 1. 按换行或句末标点（。？！～…）分割，保留问号感叹号等
  const segments = text.split(/(?<=[。？！～…])\s*/);

  for (const seg of segments) {
    let s = seg.trim();
    if (!s) continue;

    // 2. 去末尾句号（只删句号，保留？！～…）
    s = s.replace(/。+$/, "").trim();
    if (!s) continue;

    // 3. 超过阈值且有逗号 → 按逗号再拆
    if (s.length > LONG_THRESHOLD && s.includes("，")) {
      const parts = s.split("，");
      for (const part of parts) {
        const p = part.trim();
        if (p) result.push(p);
      }
    } else {
      result.push(s);
    }
  }

  return result;
}

interface Props {
  message: ChatMessage;
  onLongPress?: () => void;
  /** 是否对该消息做逐条延迟动画 */
  shouldAnimate?: boolean;
  /** 动画完成回调 */
  onAnimationDone?: () => void;
  /** 每显示一条新气泡时回调（用于自动滚底） */
  onBubbleAppear?: () => void;
}

export default function ChatBubble({ message, onLongPress, shouldAnimate, onAnimationDone, onBubbleAppear }: Props) {
  const isUser = message.role === "user";
  const colors = useTheme();
  const customColors = useCurrentCustomColors();
  const [pressed, setPressed] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  // AI 消息按段落分割成多个气泡（模拟真人聊天风格）
  const paragraphs = useMemo(
    () => isUser ? [message.content] : splitForChat(message.content),
    [isUser, message.content]
  );

  // 逐条延迟显示：仅消息首次出现时判断一次，后续不再变化
  const animateRef = useRef(!isUser && shouldAnimate && paragraphs.length > 1);
  const shouldDelay = animateRef.current;
  const [visibleCount, setVisibleCount] = useState(shouldDelay ? 1 : paragraphs.length);
  useEffect(() => {
    if (!shouldDelay) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 1; i < paragraphs.length; i++) {
      timers.push(setTimeout(() => {
        setVisibleCount(i + 1);
        onBubbleAppear?.();
        if (i === paragraphs.length - 1) {
          onAnimationDone?.();
        }
      }, i * 800));
    }
    return () => timers.forEach(clearTimeout);
  }, [message.id]);

  const bubbleContent = (
    <>
      {/* 思考过程（仅 AI 消息且有 thinking 内容） */}
      {!isUser && message.thinking && (
        <View style={[styles.thinkingRow]}>
          <Pressable
            style={[styles.thinkingToggle, { backgroundColor: colors.bg, borderColor: colors.border }]}
            onPress={() => setThinkingExpanded(!thinkingExpanded)}
          >
            <Text style={[styles.thinkingToggleText, { color: colors.textMuted }]}>
              {thinkingExpanded ? "▾ 收起思考" : "▸ 查看思考"}
            </Text>
          </Pressable>
          {thinkingExpanded && (
            <View style={[styles.thinkingBubble, { backgroundColor: colors.bg, borderColor: colors.border }]}>
              <Text style={[styles.thinkingText, { color: colors.textMuted }]}>{message.thinking}</Text>
            </View>
          )}
        </View>
      )}

      {paragraphs.slice(0, visibleCount).map((para, index) => (
        <Pressable
          key={index}
          onLongPress={onLongPress}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          delayLongPress={400}
          style={[
            styles.row,
            isUser ? styles.rowRight : styles.rowLeft,
          ]}
        >
          <View
            style={[
              styles.bubble,
              isUser
                ? { backgroundColor: colors.bubbleUser }
                : { backgroundColor: colors.bubbleAi, borderWidth: 1, borderColor: colors.border },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text
              style={[
                styles.text,
                isUser
                  ? { color: colors.textOnAccent }
                  : { color: customColors.bubbleAiText || colors.text },
              ]}
            >
              {para.trim()}
            </Text>
          </View>
          {/* 时间戳只显示在最后一个气泡 */}
          {index === visibleCount - 1 && (
            <Text style={[styles.timestamp, { color: colors.textMuted }]}>
              {new Date(message.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
          )}
        </Pressable>
      ))}
    </>
  );

  return bubbleContent;
}

/** 流式输出气泡（AI 正在打字） */
export function StreamingBubble({ text }: { text: string }) {
  const colors = useTheme();
  return (
    <View style={[streamStyles.row, streamStyles.rowLeft]}>
      <View style={[streamStyles.bubble, { backgroundColor: colors.bubbleAi, borderWidth: 1, borderColor: colors.border }]}>
        <Text style={[streamStyles.text, { color: colors.text }]}>{text}▌</Text>
      </View>
    </View>
  );
}

const streamStyles = StyleSheet.create({
  row: { marginVertical: 4, paddingHorizontal: 16 },
  rowLeft: { alignItems: "flex-start" },
  bubble: { maxWidth: "78%", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18 },
  text: { fontSize: 15, lineHeight: 22 },
});

const styles = StyleSheet.create({
  row: {
    marginVertical: 4,
    paddingHorizontal: 16,
  },
  rowLeft: {
    alignItems: "flex-start",
  },
  rowRight: {
    alignItems: "flex-end",
  },
  bubble: {
    maxWidth: "78%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  text: {
    fontSize: 15,
    lineHeight: 22,
  },
  timestamp: {
    fontSize: 11,
    marginTop: 4,
    marginHorizontal: 4,
  },
  // 思考过程样式
  thinkingRow: {
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  thinkingToggle: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
  },
  thinkingToggleText: {
    fontSize: 12,
  },
  thinkingBubble: {
    marginTop: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    maxWidth: "85%",
  },
  thinkingText: {
    fontSize: 13,
    lineHeight: 19,
  },
});
