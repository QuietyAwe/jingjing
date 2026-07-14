// ============================================================
// P4-2: 15 轮滑动窗口聊天状态
// 仅保留最近 15 轮（30 条消息），超出从头部移除
// ============================================================

import { create } from "zustand";
import type { ChatMessage } from "@/types/schema";

const MAX_MESSAGES = 30; // 15 轮 × 2 条

interface ChatState {
  messages: ChatMessage[];
  /** 是否正在等待 AI 回复 */
  isLoading: boolean;
  /** 当前流式回复文本 */
  streamingText: string;

  addMessage: (msg: ChatMessage) => void;
  setLoading: (loading: boolean) => void;
  setStreamingText: (text: string) => void;
  appendStreamingText: (delta: string) => void;
  clearMessages: () => void;
  /** 获取用于 LLM 调用的历史消息（不含 system） */
  getHistory: () => ChatMessage[];
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  streamingText: "",

  addMessage: (msg) =>
    set((state) => {
      const next = [...state.messages, msg];
      // 滑动窗口：超出 30 条从头部移除
      if (next.length > MAX_MESSAGES) {
        return { messages: next.slice(next.length - MAX_MESSAGES) };
      }
      return { messages: next };
    }),

  setLoading: (loading) => set({ isLoading: loading }),
  setStreamingText: (text) => set({ streamingText: text }),
  appendStreamingText: (delta) =>
    set((state) => ({ streamingText: state.streamingText + delta })),

  clearMessages: () => set({ messages: [], streamingText: "", isLoading: false }),

  getHistory: () => get().messages,
}));
