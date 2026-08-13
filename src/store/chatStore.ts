// ============================================================
// 聊天状态（全量持久化）
// UI 显示全部历史，LLM 上下文仅取最近 N 轮
// ============================================================

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getThresholds } from "@/prompt/config";
import type { ChatMessage } from "@/types/schema";

export interface DebugLog {
  time: string;
  tag: string;
  text: string;
}

interface ChatState {
  messages: ChatMessage[];
  /** 是否正在等待 AI 回复 */
  isLoading: boolean;
  /** 当前流式回复文本（完整内容，用于上下文） */
  streamingText: string;
  /** 流式输出分段（UI 展示用） */
  streamingChunks: string[];
  /** 流式思考内容 */
  streamingThinking: string;
  /** 最后一次拼接的 systemPrompt（调试用） */
  lastSystemPrompt: string;
  /** 最后一次检索的关键词 */
  lastKeywords: string[];
  /** 最后一次检索的记忆数量 */
  lastMemoryCount: number;
  /** API 请求/响应日志（调试用） */
  debugLogs: DebugLog[];

  addMessage: (msg: ChatMessage) => void;
  deleteMessage: (id: string) => void;
  editMessage: (id: string, content: string) => void;
  setLoading: (loading: boolean) => void;
  setStreamingText: (text: string) => void;
  appendStreamingText: (delta: string) => void;
  setStreamingThinking: (thinking: string) => void;
  appendStreamingThinking: (delta: string) => void;
  clearMessages: () => void;
  /** 存储调试信息 */
  setDebugInfo: (systemPrompt: string, keywords: string[], memoryCount: number) => void;
  /** 添加调试日志 */
  addDebugLog: (tag: string, text: string) => void;
  /** 清空调试日志 */
  clearDebugLogs: () => void;
  /** 获取用于 LLM 调用的历史消息（不含 system） */
  getHistory: () => ChatMessage[];
  /** 从 AsyncStorage 重新加载消息（导入备份后调用） */
  reloadMessages: () => Promise<void>;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      isLoading: false,
      streamingText: "",
      streamingChunks: [],
      streamingThinking: "",
      lastSystemPrompt: "",
      lastKeywords: [],
      lastMemoryCount: 0,
      debugLogs: [],

      addMessage: (msg) =>
        set((state) => ({ messages: [...state.messages, msg] })),

      deleteMessage: (id) =>
        set((state) => ({ messages: state.messages.filter((m) => m.id !== id) })),

      editMessage: (id, content) =>
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? { ...m, content } : m)),
        })),

      setLoading: (loading) => set({ isLoading: loading }),
      setStreamingText: (text) => set({ streamingText: text, streamingChunks: text ? [text] : [] }),
      appendStreamingText: (delta) =>
        set((state) => {
          const newText = state.streamingText + delta;
          // 按换行分割（流式阶段不处理标点，完成后由 ChatBubble 统一处理）
          const parts = newText.split(/\n+/);
          const chunks = parts.filter((p) => p.trim());
          return { streamingText: newText, streamingChunks: chunks };
        }),
      setStreamingThinking: (thinking) => set({ streamingThinking: thinking }),
      appendStreamingThinking: (delta) =>
        set((state) => ({ streamingThinking: state.streamingThinking + delta })),

      clearMessages: () =>
        set({ messages: [], streamingText: "", streamingChunks: [], streamingThinking: "", isLoading: false, lastSystemPrompt: "", lastKeywords: [], lastMemoryCount: 0, debugLogs: [] }),

      setDebugInfo: (systemPrompt, keywords, memoryCount) =>
        set({ lastSystemPrompt: systemPrompt, lastKeywords: keywords, lastMemoryCount: memoryCount }),

      addDebugLog: (tag, text) =>
        set((state) => {
          const now = new Date();
          const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
          const logs = [...state.debugLogs, { time, tag, text }];
          // 保留最近 50 条
          return { debugLogs: logs.slice(-50) };
        }),

      clearDebugLogs: () => set({ debugLogs: [] }),

      /** LLM 上下文：最近 N 轮（滑动窗口，不影响完整消息记录） */
      getHistory: () => {
        const { consolidation_window_turns } = getThresholds();
        const window = consolidation_window_turns * 2; // 每轮 = user + assistant
        const msgs = get().messages;
        // 最后一条是 user（刚发送，AI 尚未回复）时，多取 1 条确保第一条是 user
        const lastRole = msgs[msgs.length - 1]?.role;
        const len = lastRole === "user" ? window + 1 : window;
        return msgs.slice(-len);
      },

      /** 从 AsyncStorage 重新加载消息（导入备份后调用） */
      reloadMessages: async () => {
        try {
          const raw = await AsyncStorage.getItem("chat_messages");
          if (raw) {
            const parsed = JSON.parse(raw);
            set({ messages: parsed.state?.messages ?? [] });
          }
        } catch (e) {
          console.warn("reloadMessages 失败:", e);
        }
      },
    }),
    {
      name: "chat_messages",
      storage: createJSONStorage(() => AsyncStorage),
      // 只持久化 messages，其他状态保持内存态
      partialize: (state) => ({ messages: state.messages }),
    }
  )
);

/** 全局调试日志函数（非 Hook，可在任何地方调用） */
export function logDebug(tag: string, text: string): void {
  useChatStore.getState().addDebugLog(tag, text);
}
