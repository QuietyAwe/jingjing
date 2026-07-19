// ============================================================
// 聊天气泡组件 — 深色气泡(用户) / 浅灰气泡(AI)
// 长按触发 onLongPress 回调
// ============================================================

import { View, Text, StyleSheet, Pressable } from "react-native";
import type { ChatMessage } from "@/types/schema";
import { useTheme, useCurrentCustomColors } from "@/theme/useTheme";
import { useState } from "react";

interface Props {
  message: ChatMessage;
  onLongPress?: () => void;
}

export default function ChatBubble({ message, onLongPress }: Props) {
  const isUser = message.role === "user";
  const colors = useTheme();
  const customColors = useCurrentCustomColors();
  const [pressed, setPressed] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  // AI 消息按段落分割成多个气泡
  const paragraphs = isUser ? [message.content] : message.content.split(/\n\n+/).filter((p) => p.trim());

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

      {paragraphs.map((para, index) => (
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
          {index === paragraphs.length - 1 && (
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
