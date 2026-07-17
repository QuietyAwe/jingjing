import { useEffect, useRef, useState } from "react";
import {
  View,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
  Modal,
} from "react-native";
import dayjs from "dayjs";

import ChatBubble, { StreamingBubble } from "@/components/ChatBubble";
import { InputBar } from "@/components/InputBar";
import { useChatStore } from "@/store/chatStore";
import { useMetaStore } from "@/store/metaStore";
import { useSettingsStore } from "@/store/settingsStore";
import { buildChatContext } from "@/memory/chatHandler";
import { streamChat } from "@/llm/foreground";
import { hasApiKey } from "@/llm/client";
import { shouldConsolidate, runConsolidation } from "@/memory/consolidation";
import { resetIdleTimer } from "@/memory/dreaming";
import { getMeta, updateBasicIdentityNickname } from "@/db/queries";
import { useTheme } from "@/theme/useTheme";
import type { ChatMessage } from "@/types/schema";

export default function ChatScreen() {
  const {
    messages,
    isLoading,
    streamingText,
    lastSystemPrompt,
    lastKeywords,
    lastMemoryCount,
    debugLogs,
    addMessage,
    deleteMessage,
    editMessage,
    setLoading,
    setStreamingText,
    appendStreamingText,
    setDebugInfo,
    clearDebugLogs,
    getHistory,
  } = useChatStore();

  const { load: loadMeta, incrementTurn } = useMetaStore();
  const { loadApiKey, saveApiKey, saveBaseUrl, saveUserNickname, apiKey, baseUrl, user_nickname, isReady } =
    useSettingsStore();

  const colors = useTheme();

  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [urlInput, setUrlInput] = useState("https://api.deepseek.com");
  const [nicknameInput, setNicknameInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  // 长按菜单状态
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editText, setEditText] = useState("");
  const [showEditModal, setShowEditModal] = useState(false);

  // 初始化
  useEffect(() => {
    loadApiKey();
    loadMeta();
  }, []);

  useEffect(() => {
    if (isReady) {
      setNicknameInput(user_nickname);
      setUrlInput(baseUrl);
    }
  }, [isReady, user_nickname, baseUrl]);

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
    if (urlInput.trim()) {
      await saveBaseUrl(urlInput.trim());
    }
    await saveApiKey(trimmed);
    if (nicknameInput.trim()) {
      await saveUserNickname(nicknameInput.trim());
      updateBasicIdentityNickname(nicknameInput.trim());
    }
    setShowKeyInput(false);
    setKeyInput("");
  };

  // 判断是否为该角色的最后一条消息
  const isLastOfRole = (msg: ChatMessage) => {
    const last = [...messages].reverse().find((m) => m.role === msg.role);
    return last?.id === msg.id;
  };

  // 长按菜单操作
  const handleAction = (action: "copy" | "delete" | "edit" | "regenerate" | "edit_resend") => {
    if (!actionTarget) return;
    setShowActionMenu(false);

    switch (action) {
      case "copy":
        try {
          const Clipboard = require("expo-clipboard");
          Clipboard.setStringAsync(actionTarget.content);
        } catch {
          // expo-clipboard 不可用时忽略
        }
        break;
      case "delete":
        setShowDeleteConfirm(true);
        break;
      case "edit":
        setEditText(actionTarget.content);
        setShowEditModal(true);
        break;
      case "regenerate":
        handleRegenerate();
        break;
      case "edit_resend":
        setEditText(actionTarget.content);
        setShowEditModal(true);
        break;
    }
  };

  const confirmDelete = () => {
    if (actionTarget) {
      deleteMessage(actionTarget.id);
    }
    setShowDeleteConfirm(false);
    setActionTarget(null);
  };

  // 执行 LLM 调用（不添加用户消息，用于重新生成/编辑后重发）
  const doLLMCall = async () => {
    setLoading(true);
    setStreamingText("");
    try {
      const history = getHistory();
      const currentEmotion = getMeta("last_emotion") || undefined;
      const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
      const context = buildChatContext(lastUserMsg?.content || "", history, currentEmotion);
      setDebugInfo(context.systemPrompt, context.keywords, context.memoryCount);

      let fullResponse = "";
      await streamChat(context.messages, {
        onDelta: (delta) => {
          fullResponse += delta;
          appendStreamingText(delta);
        },
        onDone: (text) => {
          if (text) fullResponse = text;
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

          if (shouldConsolidate()) {
            const h = useChatStore.getState().messages;
            runConsolidation(h).catch((err) =>
              console.error("[chat] 巩固流异常:", err),
            );
          }
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

  const handleEditSave = (resend: boolean) => {
    if (!actionTarget) return;
    const trimmed = editText.trim();
    if (!trimmed) return;

    if (resend) {
      editMessage(actionTarget.id, trimmed);
      const idx = messages.findIndex((m) => m.id === actionTarget.id);
      if (idx >= 0) {
        const idsToDelete = messages.slice(idx + 1).map((m) => m.id);
        idsToDelete.forEach((id) => deleteMessage(id));
      }
      setShowEditModal(false);
      setActionTarget(null);
      setTimeout(() => doLLMCall(), 100);
    } else {
      editMessage(actionTarget.id, trimmed);
      setShowEditModal(false);
      setActionTarget(null);
    }
  };

  const handleRegenerate = () => {
    if (!actionTarget || actionTarget.role !== "assistant") return;
    deleteMessage(actionTarget.id);
    setActionTarget(null);
    setTimeout(() => doLLMCall(), 100);
  };

  const handleSend = async (text: string) => {
    resetIdleTimer();

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
      const history = getHistory();
      const currentEmotion = getMeta("last_emotion") || undefined;
      const context = buildChatContext(text, history, currentEmotion);
      setDebugInfo(context.systemPrompt, context.keywords, context.memoryCount);

      let fullResponse = "";
      await streamChat(context.messages, {
        onDelta: (delta) => {
          fullResponse += delta;
          appendStreamingText(delta);
        },
        onDone: (text) => {
          if (text) fullResponse = text;
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

          if (shouldConsolidate()) {
            const history = useChatStore.getState().messages;
            runConsolidation(history).catch((err) =>
              console.error("[chat] 巩固流异常:", err),
            );
          }
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

  // API 设置界面
  if (showKeyInput) {
    return (
      <View style={[styles.setupContainer, { backgroundColor: colors.sectionBg }]}>
        <Text style={[styles.setupTitle, { color: colors.text }]}>设置 API</Text>
        <Text style={[styles.setupHint, { color: colors.textMuted }]}>支持 OpenAI / DeepSeek / Moonshot 等兼容 API</Text>

        <Text style={[styles.setupLabel, { color: colors.textMuted }]}>API 地址</Text>
        <TextInput
          style={[styles.setupInput, { borderColor: colors.border, color: colors.text }]}
          value={urlInput}
          onChangeText={setUrlInput}
          placeholder="https://api.deepseek.com/v1"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={[styles.setupLabel, { color: colors.textMuted }]}>API Key</Text>
        <TextInput
          style={[styles.setupInput, { borderColor: colors.border, color: colors.text }]}
          value={keyInput}
          onChangeText={setKeyInput}
          placeholder="sk-..."
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />

        <Text style={[styles.setupLabel, { color: colors.textMuted }]}>你希望 AI 怎么称呼你？</Text>
        <TextInput
          style={[styles.setupInput, { borderColor: colors.border, color: colors.text }]}
          value={nicknameInput}
          onChangeText={setNicknameInput}
          placeholder="留空则不指定"
          placeholderTextColor={colors.placeholder}
        />

        <TouchableOpacity style={[styles.setupButton, { backgroundColor: colors.accent }]} onPress={handleSaveKey}>
          <Text style={[styles.setupButtonText, { color: colors.textOnAccent }]}>确认</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.sectionBg }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      {/* 标题栏 */}
      <View style={[styles.header, { backgroundColor: colors.sectionBg, borderBottomColor: colors.border }]}>
        <TouchableOpacity onLongPress={() => setShowDebug(true)} delayLongPress={800}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>私藏</Text>
        </TouchableOpacity>
      </View>

      {messages.length === 0 && !isLoading && (
        <View style={styles.welcomeContainer}>
          <Text style={[styles.welcomeHint, { color: colors.textMuted }]}>你愿意和我聊聊吗？</Text>
        </View>
      )}

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ChatBubble
            message={item}
            onLongPress={() => {
              setActionTarget(item);
              setShowActionMenu(true);
            }}
          />
        )}
        contentContainerStyle={styles.listContent}
        style={styles.list}
        onContentSizeChange={() =>
          flatListRef.current?.scrollToEnd({ animated: true })
        }
      />

      {streamingText ? <StreamingBubble text={streamingText} /> : null}
      {isLoading && !streamingText ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text style={[styles.loadingText, { color: colors.textMuted }]}>思考中...</Text>
        </View>
      ) : null}

      <InputBar onSend={handleSend} disabled={isLoading} />

      {/* 长按操作菜单 */}
      <Modal visible={showActionMenu} transparent animationType="fade" onRequestClose={() => setShowActionMenu(false)}>
        <Pressable style={[styles.overlay, { backgroundColor: colors.overlayBg }]} onPress={() => setShowActionMenu(false)}>
          <View style={[styles.actionSheet, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.actionTitle, { color: colors.textMuted }]}>
              {actionTarget?.role === "user" ? "消息操作" : "AI 回复操作"}
            </Text>
            {actionTarget?.role === "assistant" && isLastOfRole(actionTarget) && (
              <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("regenerate")}>
                <Text style={[styles.actionText, { color: colors.text }]}>🔄 重新生成</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("copy")}>
              <Text style={[styles.actionText, { color: colors.text }]}>📋 复制</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("edit")}>
              <Text style={[styles.actionText, { color: colors.text }]}>✏️ 编辑</Text>
            </TouchableOpacity>
            {actionTarget?.role === "user" && isLastOfRole(actionTarget) && (
              <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("edit_resend")}>
                <Text style={[styles.actionText, { color: colors.text }]}>📤 编辑并重新发送</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("delete")}>
              <Text style={[styles.actionText, { color: colors.danger }]}>🗑️ 删除</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionCancel, { backgroundColor: colors.bg }]} onPress={() => setShowActionMenu(false)}>
              <Text style={[styles.actionCancelText, { color: colors.textMuted }]}>取消</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* 删除确认 */}
      <Modal visible={showDeleteConfirm} transparent animationType="fade" onRequestClose={() => setShowDeleteConfirm(false)}>
        <Pressable style={[styles.overlay, { backgroundColor: colors.overlayBg }]} onPress={() => setShowDeleteConfirm(false)}>
          <View style={[styles.confirmBox, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.confirmTitle, { color: colors.text }]}>确认删除？</Text>
            <Text style={[styles.confirmDesc, { color: colors.textMuted }]}>删除后无法恢复</Text>
            <View style={styles.confirmButtons}>
              <TouchableOpacity style={[styles.confirmCancel, { backgroundColor: colors.btnBg }]} onPress={() => setShowDeleteConfirm(false)}>
                <Text style={[styles.confirmCancelText, { color: colors.text }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.confirmDelete, { backgroundColor: colors.danger }]} onPress={confirmDelete}>
                <Text style={[styles.confirmDeleteText, { color: colors.textOnAccent }]}>删除</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* 编辑消息 */}
      <Modal visible={showEditModal} animationType="slide" onRequestClose={() => setShowEditModal(false)}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <View style={[styles.editContainer, { backgroundColor: colors.sectionBg }]}>
            <View style={[styles.editHeader, { backgroundColor: colors.sectionBg, borderBottomColor: colors.border }]}>
              <TouchableOpacity onPress={() => setShowEditModal(false)}>
                <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
              </TouchableOpacity>
              <Text style={[styles.editTitle, { color: colors.text }]}>编辑消息</Text>
              <View style={{ width: 50 }} />
            </View>
            <TextInput
              style={[styles.editInput, { color: colors.text }]}
              value={editText}
              onChangeText={setEditText}
              multiline
              autoFocus
              textAlignVertical="top"
            />
            <View style={[styles.editButtons, { borderTopColor: colors.border }]}>
              <TouchableOpacity
                style={[styles.editSaveBtn, { backgroundColor: colors.btnBg }]}
                onPress={() => handleEditSave(false)}
              >
                <Text style={[styles.editSaveBtnText, { color: colors.text }]}>完成</Text>
              </TouchableOpacity>
              {actionTarget?.role === "user" && isLastOfRole(actionTarget) && (
                <TouchableOpacity
                  style={[styles.editResendBtn, { backgroundColor: colors.accent }]}
                  onPress={() => handleEditSave(true)}
                >
                  <Text style={[styles.editResendBtnText, { color: colors.textOnAccent }]}>完成并发送</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* 调试弹窗 */}
      <Modal visible={showDebug} animationType="slide" onRequestClose={() => setShowDebug(false)}>
        <View style={[styles.debugContainer, { backgroundColor: colors.bg }]}>
          <View style={[styles.debugHeader, { backgroundColor: colors.sectionBg, borderBottomColor: colors.border }]}>
            <Text style={[styles.debugTitle, { color: colors.text }]}>🔧 开发者调试</Text>
            <TouchableOpacity onPress={() => setShowDebug(false)}>
              <Text style={[styles.debugClose, { color: colors.accent }]}>关闭</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.debugScroll}>
            <Text style={[styles.debugLabel, { color: colors.textMuted }]}>检索关键词</Text>
            <Text style={[styles.debugValue, { color: colors.text }]}>
              {lastKeywords.length > 0 ? lastKeywords.join(" / ") : "（无）"}
            </Text>

            <Text style={[styles.debugLabel, { color: colors.textMuted }]}>记忆命中数</Text>
            <Text style={[styles.debugValue, { color: colors.text }]}>{lastMemoryCount}</Text>

            <Text style={[styles.debugLabel, { color: colors.textMuted }]}>System Prompt</Text>
            <View style={[styles.debugPromptBox, { backgroundColor: colors.sectionBg, borderColor: colors.border }]}>
              <Text style={[styles.debugPromptText, { color: colors.text }]} selectable>
                {lastSystemPrompt || "（尚未发送消息）"}
              </Text>
            </View>

            <View style={styles.debugLogHeader}>
              <Text style={[styles.debugLabel, { color: colors.textMuted }]}>运行日志</Text>
              <TouchableOpacity onPress={clearDebugLogs}>
                <Text style={[styles.debugClearLog, { color: colors.accent }]}>清空</Text>
              </TouchableOpacity>
            </View>
            {debugLogs.length === 0 ? (
              <Text style={[styles.debugValue, { color: colors.text }]}>（暂无日志）</Text>
            ) : (
              debugLogs.map((log, i) => (
                <View key={i} style={[styles.debugLogEntry, { backgroundColor: colors.sectionBg, borderColor: colors.border }]}>
                  <Text style={[styles.debugLogTime, { color: colors.textMuted }]}>{log.time}</Text>
                  <Text style={[styles.debugLogTag, { color: colors.accent }]}>{log.tag}</Text>
                  <Text style={[styles.debugLogText, { color: colors.text }]} selectable>{log.text}</Text>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { flex: 1 },
  listContent: { paddingTop: 16, paddingBottom: 8 },
  header: {
    paddingTop: 56, paddingBottom: 12, paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 20, fontWeight: "700", letterSpacing: 2 },
  welcomeContainer: { alignItems: "center", justifyContent: "center", paddingTop: 80, paddingBottom: 40 },
  welcomeHint: { fontSize: 15, marginTop: 12 },
  loadingRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingVertical: 12 },
  loadingText: { fontSize: 13, marginLeft: 8 },
  // API 设置
  setupContainer: { flex: 1, justifyContent: "center", paddingHorizontal: 40 },
  setupTitle: { fontSize: 24, fontWeight: "700", marginBottom: 8 },
  setupHint: { fontSize: 14, marginBottom: 24 },
  setupLabel: { fontSize: 13, fontWeight: "600", marginBottom: 6 },
  setupInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, marginBottom: 16 },
  setupButton: { borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  setupButtonText: { fontSize: 15, fontWeight: "600" },
  // 调试弹窗
  debugContainer: { flex: 1 },
  debugHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingTop: 56, paddingBottom: 16, paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  debugTitle: { fontSize: 18, fontWeight: "700" },
  debugClose: { fontSize: 15, fontWeight: "600" },
  debugScroll: { flex: 1, padding: 20 },
  debugLabel: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1, marginTop: 16, marginBottom: 6 },
  debugValue: { fontSize: 14, lineHeight: 20 },
  debugPromptBox: { borderRadius: 8, padding: 16, marginTop: 4, borderWidth: 1 },
  debugPromptText: { fontSize: 13, lineHeight: 20, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  debugLogHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  debugClearLog: { fontSize: 13, fontWeight: "600", marginTop: 16 },
  debugLogEntry: { borderRadius: 8, padding: 12, marginBottom: 8, borderWidth: 1 },
  debugLogTime: { fontSize: 11, marginBottom: 4 },
  debugLogTag: { fontSize: 12, fontWeight: "700", marginBottom: 4 },
  debugLogText: { fontSize: 12, lineHeight: 18, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  // 操作菜单
  overlay: { flex: 1, justifyContent: "flex-end" },
  actionSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 34, paddingTop: 8 },
  actionTitle: { fontSize: 13, textAlign: "center", paddingVertical: 12 },
  actionItem: { paddingVertical: 16, paddingHorizontal: 24, borderTopWidth: StyleSheet.hairlineWidth },
  actionText: { fontSize: 17, textAlign: "center" },
  actionCancel: { marginTop: 8 },
  actionCancelText: { fontSize: 17, textAlign: "center" },
  // 删除确认
  confirmBox: { borderRadius: 14, padding: 24, marginHorizontal: 40, alignSelf: "center", marginTop: "auto", marginBottom: "auto" },
  confirmTitle: { fontSize: 17, fontWeight: "600", textAlign: "center" },
  confirmDesc: { fontSize: 14, textAlign: "center", marginTop: 8 },
  confirmButtons: { flexDirection: "row", marginTop: 20, gap: 12 },
  confirmCancel: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  confirmCancelText: { fontSize: 15 },
  confirmDelete: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  confirmDeleteText: { fontSize: 15, fontWeight: "600" },
  // 编辑消息
  editContainer: { flex: 1 },
  editHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingTop: 56, paddingBottom: 16, paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  editTitle: { fontSize: 17, fontWeight: "600" },
  cancelText: { fontSize: 15 },
  editInput: { flex: 1, marginHorizontal: 20, marginTop: 16, fontSize: 15, lineHeight: 24, textAlignVertical: "top" },
  editButtons: {
    flexDirection: "row", paddingHorizontal: 20, paddingVertical: 16, paddingBottom: 34,
    gap: 12, borderTopWidth: StyleSheet.hairlineWidth,
  },
  editSaveBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  editSaveBtnText: { fontSize: 15, fontWeight: "600" },
  editResendBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  editResendBtnText: { fontSize: 15, fontWeight: "600" },
});
