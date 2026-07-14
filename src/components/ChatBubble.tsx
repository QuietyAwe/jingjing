import { Text, View, StyleSheet } from "react-native";
import type { ChatMessage } from "@/types/schema";

interface Props {
  message: ChatMessage;
}

export function ChatBubble({ message }: Props) {
  const isUser = message.role === "user";

  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        <Text style={[styles.text, isUser && styles.textUser]}>
          {message.content}
        </Text>
      </View>
    </View>
  );
}

/** 流式渲染中的 AI 气泡 */
export function StreamingBubble({ text }: { text: string }) {
  return (
    <View style={styles.row}>
      <View style={styles.bubbleAssistant}>
        <Text style={styles.text}>{text}</Text>
        <Text style={styles.cursor}>▊</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 20,
    paddingVertical: 4,
    flexDirection: "row",
    justifyContent: "flex-start",
  },
  rowUser: {
    justifyContent: "flex-end",
  },
  bubble: {
    maxWidth: "80%",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
  },
  bubbleUser: {
    backgroundColor: "#2F81F7",
  },
  bubbleAssistant: {
    backgroundColor: "#F7F7F5",
  },
  text: {
    fontSize: 15,
    lineHeight: 24,
    color: "#37352F",
  },
  textUser: {
    color: "#FFFFFF",
  },
  cursor: {
    color: "#9B9A97",
    fontSize: 14,
    marginTop: 2,
  },
});
