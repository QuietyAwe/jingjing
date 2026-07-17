// ============================================================
// 聊天气泡组件 — 深色气泡(用户) / 浅灰气泡(AI)
// 长按触发 onLongPress 回调
// ============================================================

import { View, Text, StyleSheet, Pressable } from "react-native";
import type { ChatMessage } from "@/types/schema";
import { useTheme } from "@/theme/useTheme";
import { useState } from "react";

interface Props {
  message: ChatMessage;
  onLongPress?: () => void;
}

export default function ChatBubble({ message, onLongPress }: Props) {
  const isUser = message.role === "user";
  const colors = useTheme();
  const [pressed, setPressed] = useState(false);

  return (
    <Pressable
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
              : { color: colors.text },
          ]}
        >
          {message.content}
        </Text>
      </View>
      <Text style={[styles.timestamp, { color: colors.textMuted }]}>
        {new Date(message.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </Text>
    </Pressable>
  );
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
});
