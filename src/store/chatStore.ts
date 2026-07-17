// ============================================================
// 聊天状态（全量持久化）
// UI 显示全部历史，LLM 上下文仅取最近 15 轮
// ============================================================

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatMessage } from "@/types/schema";

const CONTEXT_WINDOW = 30; // LLM 上下文：最近 15 轮 × 2 条

export interface DebugLog {
  time: string;
  tag: string;
  text: string;
}

interface ChatState {
  messages: ChatMessage[];
  /** 是否正在等待 AI 回复 */
  isLoading: boolean;
  /** 当前流式回复文本 */
  streamingText: string;
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
  clearMessages: () => void;
  /** 存储调试信息 */
  setDebugInfo: (systemPrompt: string, keywords: string[], memoryCount: number) => void;
  /** 添加调试日志 */
  addDebugLog: (tag: string, text: string) => void;
  /** 清空调试日志 */
  clearDebugLogs: () => void;
  /** 获取用于 LLM 调用的历史消息（不含 system） */
  getHistory: () => ChatMessage[];
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      isLoading: false,
      streamingText: "",
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
      setStreamingText: (text) => set({ streamingText: text }),
      appendStreamingText: (delta) =>
        set((state) => ({ streamingText: state.streamingText + delta })),

      clearMessages: () =>
        set({ messages: [], streamingText: "", isLoading: false, lastSystemPrompt: "", lastKeywords: [], lastMemoryCount: 0, debugLogs: [] }),

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

      /** LLM 上下文：最近 15 轮 */
      getHistory: () => get().messages.slice(-CONTEXT_WINDOW),
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
