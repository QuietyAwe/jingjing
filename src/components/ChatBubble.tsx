// ============================================================
// 聊天气泡组件 — 深色气泡(用户) / 浅灰气泡(AI)
// 长按触发 onLongPress 回调
// ============================================================

import { View, Text, StyleSheet, Pressable } from "react-native";
import type { ChatMessage } from "@/types/schema";
import { useTheme, useCurrentCustomColors } from "@/theme/useTheme";
import { useState, useMemo, useEffect, useRef } from "react";
import { useSettingsStore } from "@/store/settingsStore";

/** 模拟真人聊天风格：按换行分段 + 按句末标点分割 + 去句号 + 长句逗号再拆 */
function splitForChat(text: string): string[] {
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

interface Props {
  message: ChatMessage;
  onLongPress?: () => void;
  /** 非流式模式下对该消息做逐条延迟动画 */
  shouldAnimate?: boolean;
  /** 每显示一条新气泡时回调（用于自动滚底） */
  onBubbleAppear?: () => void;
}

export default function ChatBubble({ message, onLongPress, shouldAnimate, onBubbleAppear }: Props) {
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

  // 非流式模式：按字数逐条延迟显示，首次出现时锁定决策
  const animateRef = useRef(!isUser && shouldAnimate && paragraphs.length > 1);
  const shouldDelay = animateRef.current;
  const [visibleCount, setVisibleCount] = useState(shouldDelay ? 1 : paragraphs.length);
  useEffect(() => {
    if (!shouldDelay) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let acc = 0;
    for (let i = 1; i < paragraphs.length; i++) {
      // 按字数计算延迟：每字 50ms，范围 500ms ~ 3000ms
      const delay = Math.min(3000, Math.max(500, paragraphs[i - 1].length * 50));
      acc += delay;
      timers.push(setTimeout(() => {
        setVisibleCount(i + 1);
        onBubbleAppear?.();
      }, acc));
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
              // 连续气泡做视觉分组：相邻两边用小圆角，看起来像一叠卡片而不是散落的块
              index < visibleCount - 1 && (isUser
                ? { borderBottomRightRadius: 6 }
                : { borderBottomLeftRadius: 6 }),
              index > 0 && (isUser
                ? { borderTopRightRadius: 6 }
                : { borderTopLeftRadius: 6 }),
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
  row: { marginVertical: 2, paddingHorizontal: 16 },
  rowLeft: { alignItems: "flex-start" },
  bubble: { maxWidth: "84%", paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18 },
  text: { fontSize: 15, lineHeight: 21 },
});

const styles = StyleSheet.create({
  row: {
    marginVertical: 2,
    paddingHorizontal: 16,
  },
  rowLeft: {
    alignItems: "flex-start",
  },
  rowRight: {
    alignItems: "flex-end",
  },
  bubble: {
    maxWidth: "84%",
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 18,
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
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
