import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  FlatList,
  StyleSheet,
  Keyboard,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Modal,
  Alert,
} from "react-native";
import dayjs from "dayjs";

import ChatBubble, { StreamingBubble } from "@/components/ChatBubble";
import { InputBar } from "@/components/InputBar";
import { useChatStore, logDebug } from "@/store/chatStore";
import { useMetaStore } from "@/store/metaStore";
import { useSettingsStore } from "@/store/settingsStore";
import { buildChatContext } from "@/memory/chatHandler";
import { streamChat } from "@/llm/foreground";
import { hasApiKey } from "@/llm/client";
import { shouldConsolidate, runConsolidation } from "@/memory/consolidation";
import { checkDuePromises, markPromiseReminded } from "@/memory/promiseChecker";
import { checkAndGenerateSchedule } from "@/memory/scheduler";
import { useTheme } from "@/theme/useTheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import type { ChatMessage } from "@/types/schema";

/** 首屏渲染的消息条数（更早的消息滑到顶部时再加载） */
const PAGE_SIZE = 30;

export default function ChatScreen() {
  const {
    messages,
    isLoading,
    streamingText,
    streamingChunks,
    streamingThinking,
    debugLogs,
    addMessage,
    deleteMessage,
    editMessage,
    setLoading,
    setStreamingText,
    appendStreamingText,
    setStreamingThinking,
    appendStreamingThinking,
    setDebugInfo,
    clearDebugLogs,
    getHistory,
  } = useChatStore();

  const { load: loadMeta, incrementTurn } = useMetaStore();
  const { loadApiKey, saveApiKey, saveBaseUrl, saveUserNickname, apiKey, baseUrl, user_nickname, ai_name, isReady } =
    useSettingsStore();

  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [urlInput, setUrlInput] = useState("https://api.deepseek.com");
  const [nicknameInput, setNicknameInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [dotsCount, setDotsCount] = useState(0);
  const flatListRef = useRef<FlatList>(null);

  // 长按菜单状态
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editText, setEditText] = useState("");
  const [showEditModal, setShowEditModal] = useState(false);

  // 逐条延迟动画：仅非流式模式下对刚收到的 AI 回复生效
  const [animatingMsgId, setAnimatingMsgId] = useState<string | null>(null);
  // 编辑/删除操作时不自动滚底
  const skipScrollRef = useRef(false);
  // 用户是否贴在底部：只有贴底时才自动滚动，避免上翻历史时被强行拽回底部
  const atBottomRef = useRef(true);
  /**
   * 首屏只渲染最后 PAGE_SIZE 条并全部渲染：
   * FlatList 懒渲染时未渲染项的高度是估算值，contentSize 不准会导致定位偏移，
   * 因此限定一个较小的窗口，让首屏高度是真实值
   */
  const [renderCount, setRenderCount] = useState(PAGE_SIZE);
  const visibleMessages = useMemo(
    () => (messages.length > renderCount ? messages.slice(-renderCount) : messages),
    [messages, renderCount]
  );
  const hasMore = messages.length > renderCount;

  /** 贴底时才滚到底部 */
  const scrollToBottomIfNeeded = useCallback((animated = true) => {
    if (!atBottomRef.current) return false;
    if (skipScrollRef.current) return false;
    // scrollToOffset 超出范围会自动 clamp 到末尾，比 scrollToEnd 更可靠
    flatListRef.current?.scrollToOffset({ offset: 9_999_999, animated });
    return true;
  }, []);

  /** 无条件对齐底部（打开 App 时的初始定位） */
  const scrollToBottomHard = useCallback(() => {
    requestAnimationFrame(() => {
      flatListRef.current?.scrollToOffset({ offset: 9_999_999, animated: false });
    });
  }, []);

  /**
   * 布局阶段同步定位：onLayout / onContentSizeChange 都早于绘制，
   * 在这里滚动可以让「第一帧」就画在底部，消除可见的跳动。
   * 仅在打开后的初始窗口内生效，之后不再干预，避免打扰上翻历史
   */
  const initialWindowRef = useRef(true);
  const scrollOnLayout = useCallback(() => {
    if (!initialWindowRef.current) return;
    flatListRef.current?.scrollToOffset({ offset: 9_999_999, animated: false });
  }, []);

  // 初始窗口结束：之后完全交给 atBottomRef 控制
  useEffect(() => {
    const t = setTimeout(() => {
      initialWindowRef.current = false;
    }, 1000);
    return () => clearTimeout(t);
  }, []);

  /**
   * 打开 App 时定位到最新消息
   * 只做「尽早 + 补一次」两次，且都在渲染后极短时间内完成，肉眼看不到跳变
   */
  useEffect(() => {
    if (messages.length === 0) return;
    if (!initialWindowRef.current) return;
    scrollToBottomHard();
    const t = setTimeout(scrollToBottomHard, 120);
    return () => clearTimeout(t);
  }, [messages.length, scrollToBottomHard]);

  // 初始化
  useEffect(() => {
    loadApiKey();
    loadMeta();
  }, []);

  // AI 作息时间表：进入聊天时检查本周是否已生成（不在发送路径上，避免阻塞首条消息）
  useEffect(() => {
    if (!isReady) return;
    checkAndGenerateSchedule().catch((err) => {
      console.error("[chat] 时间表生成异常:", err);
    });
  }, [isReady]);

  // 检查到期约定
  useEffect(() => {
    if (!isReady) return;

    const checkPromises = () => {
      const duePromises = checkDuePromises();
      if (duePromises.length === 0) return;

      // 为每个到期约定发送系统消息
      for (const { task, message } of duePromises) {
        const sysMsg: ChatMessage = {
          id: dayjs().valueOf().toString() + "_promise",
          role: "user",
          content: `[系统消息] ${message}`,
          timestamp: dayjs().toISOString(),
        };
        addMessage(sysMsg);

        // 标记已提醒（内部完成数据库更新）
        markPromiseReminded(task.task_name);

        logDebug("约定提醒", `已提醒: ${task.task_name}`);
      }
    };

    // 立即检查一次
    checkPromises();

    // 每分钟检查一次
    const timer = setInterval(checkPromises, 60000);
    return () => clearInterval(timer);
  }, [isReady]);

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

  // 流式输出时滚动到底部（仅在用户贴底时，上翻历史不打扰）
  useEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      return;
    }
    if (streamingText) {
      scrollToBottomIfNeeded(true);
    }
  }, [streamingText, scrollToBottomIfNeeded]);

  // 打字动画
  useEffect(() => {
    if (!isLoading) {
      setDotsCount(0);
      return;
    }
    const timer = setInterval(() => {
      setDotsCount((prev) => (prev + 1) % 4);
    }, 500);
    return () => clearInterval(timer);
  }, [isLoading]);

  // 键盘弹出时滚动到底部
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => {
      // 上翻历史时键盘弹出不打断阅读
      setTimeout(() => scrollToBottomIfNeeded(true), 100);
    });
    return () => sub.remove();
  }, []);

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    if (urlInput.trim()) {
      await saveBaseUrl(urlInput.trim());
    }
    await saveApiKey(trimmed);
    if (nicknameInput.trim()) {
      // 称呼的唯一写入口（写入 user_info 画像）
      await saveUserNickname(nicknameInput.trim());
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
  const handleAction = async (action: "copy" | "delete" | "edit" | "regenerate") => {
    if (!actionTarget) return;
    setShowActionMenu(false);

    switch (action) {
      case "copy":
        try {
          const { Clipboard } = require("react-native");
          Clipboard.setString(actionTarget.content);
          Alert.alert("已复制", "消息内容已复制到剪贴板");
        } catch (e) {
          console.warn("复制失败:", e);
          Alert.alert("复制失败", "无法复制消息内容");
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
    }
  };

  const confirmDelete = () => {
    if (actionTarget) {
      skipScrollRef.current = true;
      deleteMessage(actionTarget.id);
    }
    setShowDeleteConfirm(false);
    setActionTarget(null);
  };

  // 执行 LLM 调用（不添加用户消息，用于重新生成/编辑后重发）
  const doLLMCall = async () => {
    setLoading(true);
    setStreamingText("");
    setStreamingThinking("");
    try {
      const history = getHistory();
      const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
      const context = buildChatContext(lastUserMsg?.content || "", history);
      setDebugInfo(context.systemPrompt, context.keywords, context.memoryCount);

      let fullResponse = "";
      let fullThinking = "";
      await streamChat(context.messages, {
        onDelta: (delta) => {
          fullResponse += delta;
          appendStreamingText(delta);
        },
        onThinking: (thinking) => {
          fullThinking += thinking;
          appendStreamingThinking(thinking);
        },
        onDone: (text, thinking) => {
          if (text) fullResponse = text;
          if (thinking) fullThinking = thinking;
          const aiMsg: ChatMessage = {
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: fullResponse,
            timestamp: dayjs().toISOString(),
            thinking: fullThinking || undefined,
          };
          addMessage(aiMsg);
          setStreamingText("");
          setStreamingThinking("");
          setLoading(false);
          // 非流式模式：消息一次性出现，需要逐条延迟动画
          if (!useSettingsStore.getState().stream_output) {
            setAnimatingMsgId(aiMsg.id);
          }

          const shouldRun = shouldConsolidate();
          if (shouldRun) {
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
          setStreamingThinking("");
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
      setStreamingThinking("");
      setLoading(false);
    }
  };

  const handleEditSave = (resend: boolean) => {
    if (!actionTarget) return;
    const trimmed = editText.trim();
    if (!trimmed) return;

    skipScrollRef.current = true;
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
    skipScrollRef.current = true;
    deleteMessage(actionTarget.id);
    setActionTarget(null);
    setTimeout(() => doLLMCall(), 100);
  };

  const handleSend = async (text: string) => {
    // 用户主动发言，视为回到对话底部，后续新气泡可自动滚底
    atBottomRef.current = true;

    // 上一轮完成（最后一条是 AI 回复）才计数
    const currentHistory = getHistory();
    const lastRole = currentHistory.length > 0 ? currentHistory[currentHistory.length - 1].role : "none";
    if (lastRole === "assistant") {
      incrementTurn();
    }
    const counter = useMetaStore.getState().turnCounter;
    const locked = useMetaStore.getState().isLocked;
    logDebug("轮次计数", `lastRole=${lastRole}, turn_counter=${counter}, is_locked=${locked}`);

    const userMsg: ChatMessage = {
      id: dayjs().valueOf().toString(),
      role: "user",
      content: text,
      timestamp: dayjs().toISOString(),
    };
    addMessage(userMsg);
    setLoading(true);
    setStreamingText("");
    setStreamingThinking("");

    try {
      const history = getHistory();
      const context = buildChatContext(text, history);
      setDebugInfo(context.systemPrompt, context.keywords, context.memoryCount);

      let fullResponse = "";
      let fullThinking = "";
      await streamChat(context.messages, {
        onDelta: (delta) => {
          fullResponse += delta;
          appendStreamingText(delta);
        },
        onThinking: (thinking) => {
          fullThinking += thinking;
          appendStreamingThinking(thinking);
        },
        onDone: (text, thinking) => {
          if (text) fullResponse = text;
          if (thinking) fullThinking = thinking;
          const aiMsg: ChatMessage = {
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: fullResponse,
            timestamp: dayjs().toISOString(),
            thinking: fullThinking || undefined,
          };
          addMessage(aiMsg);
          setStreamingText("");
          setStreamingThinking("");
          setLoading(false);
          // 流式输出已实时展示，不需要逐条延迟动画

          const shouldRun = shouldConsolidate();
          if (shouldRun) {
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
          setStreamingThinking("");
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
      setStreamingThinking("");
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
      style={[styles.container, { backgroundColor: colors.bg }]}
      behavior="padding"
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      {/* 标题栏（紧凑：按安全区适配，右侧提供设置入口） */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 6,
            backgroundColor: colors.sectionBg,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <TouchableOpacity onLongPress={() => setShowDebug(true)} delayLongPress={800}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            {isLoading ? `正在输入中${".".repeat(dotsCount)}` : (ai_name || "私藏")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push("/settings")}
          style={styles.headerAction}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={[styles.headerActionText, { color: colors.textMuted }]}>设置</Text>
        </TouchableOpacity>
      </View>

      {messages.length === 0 && !isLoading && (
        <View style={styles.welcomeContainer}>
          <Text style={[styles.welcomeHint, { color: colors.textMuted }]}>你愿意和我聊聊吗？</Text>
        </View>
      )}

      <FlatList
        ref={flatListRef}
        data={visibleMessages}
        keyExtractor={(item) => item.id}
        // 首屏窗口内全部渲染，保证 contentSize 是真实值
        initialNumToRender={visibleMessages.length}
        // 滑到顶部时加载更早的消息
        onStartReached={() => {
          if (hasMore) {
            setRenderCount((c) => Math.min(c + PAGE_SIZE, messages.length));
          }
        }}
        onStartReachedThreshold={0.2}
        // 顶部插入更早消息时保持当前可见位置，不跳动
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        // 布局阶段即对齐底部（早于绘制，避免看到从顶部跳到底部）
        onLayout={scrollOnLayout}
        onContentSizeChange={scrollOnLayout}
        // 用户一旦开始滑动就结束初始窗口，彻底交还控制权
        onScrollBeginDrag={() => {
          initialWindowRef.current = false;
        }}
        // 追踪是否贴底：距底部 80pt 内视为贴底
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          const distanceFromBottom =
            contentSize.height - layoutMeasurement.height - contentOffset.y;
          atBottomRef.current = distanceFromBottom < 80;
        }}
        scrollEventThrottle={16}
        renderItem={({ item }) => (
          <ChatBubble
            message={item}
            shouldAnimate={item.id === animatingMsgId}
            onBubbleAppear={() => {
              // 新气泡出现属于正常消息流，但仅在贴底时才滚
              skipScrollRef.current = false;
              setTimeout(() => scrollToBottomIfNeeded(true), 50);
            }}
            onLongPress={() => {
              setActionTarget(item);
              setShowActionMenu(true);
            }}
          />
        )}
        ListFooterComponent={
          (streamingThinking || streamingChunks.length > 0) ? (
            <>
              {/* 流式思考气泡 */}
              {streamingThinking ? (
                <View style={[styles.thinkingContainer, { borderColor: colors.border }]}>
                  <Text style={[styles.thinkingLabel, { color: colors.textMuted }]}>💭 思考中...</Text>
                  <Text style={[styles.thinkingText, { color: colors.textMuted }]}>{streamingThinking}</Text>
                </View>
              ) : null}
              {/* 流式内容气泡 */}
              {streamingChunks.map((chunk, index) => (
                <StreamingBubble key={index} text={chunk} />
              ))}
            </>
          ) : null
        }
        contentContainerStyle={styles.listContent}
        style={styles.list}
      />

      {/* 底栏隐藏后需自行避让系统手势区 */}
      <View style={{ paddingBottom: insets.bottom }}>
        <InputBar onSend={handleSend} disabled={isLoading} />
      </View>

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
          style={{ flex: 1, backgroundColor: colors.bg }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
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

          <ScrollView
            ref={(ref) => { if (ref && debugLogs.length > 0) setTimeout(() => ref.scrollToEnd({ animated: false }), 100); }}
            style={styles.debugScroll}
          >
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 6, paddingBottom: 6, paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 16, fontWeight: "600", letterSpacing: 1 },
  headerAction: { paddingVertical: 4, paddingLeft: 12 },
  headerActionText: { fontSize: 13 },
  welcomeContainer: { alignItems: "center", justifyContent: "center", paddingTop: 80, paddingBottom: 40 },
  welcomeHint: { fontSize: 15, marginTop: 12 },
  loadingBubble: {
    marginHorizontal: 16,
    marginVertical: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderWidth: 1,
    alignSelf: "flex-start",
    maxWidth: "78%",
  },
  loadingText: { fontSize: 15 },
  // 思考气泡
  thinkingContainer: {
    marginHorizontal: 16,
    marginVertical: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "dashed",
    maxWidth: "85%",
  },
  thinkingLabel: {
    fontSize: 12,
    marginBottom: 4,
  },
  thinkingText: {
    fontSize: 13,
    lineHeight: 19,
  },
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
