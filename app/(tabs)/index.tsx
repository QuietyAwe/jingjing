import { useEffect, useRef, useState } from "react";
import {
  View,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import dayjs from "dayjs";

import { ChatBubble, StreamingBubble } from "@/components/ChatBubble";
import { InputBar } from "@/components/InputBar";
import { useChatStore } from "@/store/chatStore";
import { useMetaStore } from "@/store/metaStore";
import { useSettingsStore } from "@/store/settingsStore";
import { buildChatContext } from "@/memory/chatHandler";
import { streamChat } from "@/llm/foreground";
import { hasApiKey } from "@/llm/client";
import type { ChatMessage } from "@/types/schema";

export default function ChatScreen() {
  const {
    messages,
    isLoading,
    streamingText,
    addMessage,
    setLoading,
    setStreamingText,
    appendStreamingText,
    getHistory,
  } = useChatStore();

  const { load: loadMeta, incrementTurn } = useMetaStore();
  const { loadApiKey, saveApiKey, apiKey, isReady } = useSettingsStore();

  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const flatListRef = useRef<FlatList>(null);

  // 初始化
  useEffect(() => {
    loadApiKey();
    loadMeta();
  }, []);

  // 检查 API Key
  useEffect(() => {
    if (isReady && !hasApiKey()) {
      setShowKeyInput(true);
    }
  }, [isReady]);

  // 自动滚动到底部
  useEffect(() => {
    if (messages.length > 0 || streamingText) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length, streamingText]);

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    await saveApiKey(trimmed);
    setShowKeyInput(false);
    setKeyInput("");
  };

  const handleSend = async (text: string) => {
    // 添加用户消息
    const userMsg: ChatMessage = {
      id: dayjs().valueOf().toString(),
      role: "user",
      content: text,
      timestamp: dayjs().toISOString(),
    };
    addMessage(userMsg);
    setLoading(true);
    setStreamingText("");

    try {
      // 构建上下文
      const history = getHistory();
      const context = buildChatContext(text, history);

      // 流式调用 LLM
      let fullResponse = "";
      const chatMessages = context.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      await streamChat(context.systemPrompt, chatMessages, {
        onDelta: (delta) => {
          fullResponse += delta;
          appendStreamingText(delta);
        },
        onDone: () => {
          const aiMsg: ChatMessage = {
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: fullResponse,
            timestamp: dayjs().toISOString(),
          };
          addMessage(aiMsg);
          setStreamingText("");
          setLoading(false);
          incrementTurn();
        },
        onError: (error) => {
          const errorMsg: ChatMessage = {
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: `⚠️ ${error}`,
            timestamp: dayjs().toISOString(),
          };
          addMessage(errorMsg);
          setStreamingText("");
          setLoading(false);
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "未知错误";
      addMessage({
        id: dayjs().valueOf().toString(),
        role: "assistant",
        content: `⚠️ ${msg}`,
        timestamp: dayjs().toISOString(),
      });
      setStreamingText("");
      setLoading(false);
    }
  };

  // API Key 设置界面
  if (showKeyInput) {
    return (
      <View style={styles.setupContainer}>
        <Text style={styles.setupTitle}>设置 API Key</Text>
        <Text style={styles.setupHint}>
          请输入 OpenAI API Key 以开始使用
        </Text>
        <TextInput
          style={styles.setupInput}
          value={keyInput}
          onChangeText={setKeyInput}
          placeholder="sk-..."
          placeholderTextColor="#B0AFAF"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <TouchableOpacity style={styles.setupButton} onPress={handleSaveKey}>
          <Text style={styles.setupButtonText}>确认</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      {messages.length === 0 && !isLoading && (
        <View style={styles.welcomeContainer}>
          <Text style={styles.welcomeTitle}>私藏</Text>
          <Text style={styles.welcomeHint}>你愿意和我聊聊吗？</Text>
        </View>
      )}

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ChatBubble message={item} />}
        contentContainerStyle={styles.listContent}
        style={styles.list}
        onContentSizeChange={() =>
          flatListRef.current?.scrollToEnd({ animated: true })
        }
      />

      {streamingText ? <StreamingBubble text={streamingText} /> : null}
      {isLoading && !streamingText ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color="#9B9A97" />
          <Text style={styles.loadingText}>思考中...</Text>
        </View>
      ) : null}

      <InputBar onSend={handleSend} disabled={isLoading} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingTop: 16,
    paddingBottom: 8,
  },
  welcomeContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 120,
    paddingBottom: 40,
  },
  welcomeTitle: {
    fontSize: 28,
    fontWeight: "700",
    color: "#37352F",
    letterSpacing: 2,
  },
  welcomeHint: {
    fontSize: 15,
    color: "#9B9A97",
    marginTop: 12,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
  },
  loadingText: {
    fontSize: 13,
    color: "#9B9A97",
    marginLeft: 8,
  },
  // API Key 设置
  setupContainer: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    justifyContent: "center",
    paddingHorizontal: 40,
  },
  setupTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: "#37352F",
    marginBottom: 8,
  },
  setupHint: {
    fontSize: 14,
    color: "#9B9A97",
    marginBottom: 24,
  },
  setupInput: {
    borderWidth: 1,
    borderColor: "#E8E7E4",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#37352F",
    marginBottom: 16,
  },
  setupButton: {
    backgroundColor: "#2F81F7",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  setupButtonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
});
