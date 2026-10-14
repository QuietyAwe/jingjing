// ============================================================
// 聊天状态（全量持久化）
// UI 显示全部历史，LLM 上下文仅取最近 N 轮
// ============================================================

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getThresholds } from "@/prompt/config";
import { getGameSessionById, getUserInfo } from "@/db/queries";
import { replacePlaceholders } from "@/prompt/assembler";
import { splitForChat } from "@/utils/text";
import type { ChatMessage } from "@/types/schema";
import dayjs from "dayjs";

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
  /** 整局删除：移除该局游戏的全部消息（游戏合并卡片） */
  deleteMessagesByGameId: (gameId: number) => void;
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

/**
 * 对局时间范围：开始 ~ 结束（同日省略第二个日期）
 * 例：`10/2 14:30 ~ 15:10`；跨日则 `10/2 23:50 ~ 10/3 00:20`
 */
function formatGameTimeRange(startedAt: string, endedAt: string | null): string {
  const start = dayjs(startedAt);
  const end = dayjs(endedAt || startedAt);
  return start.isSame(end, "day")
    ? `${start.format("M/D HH:mm")} ~ ${end.format("HH:mm")}`
    : `${start.format("M/D HH:mm")} ~ ${end.format("M/D HH:mm")}`;
}

/**
 * 把已结束对局的游戏对话合并成一条摘要
 *
 * 进行中的对局保留完整对话（让 AI 能接上文）；
 * 已结束的对局只保留一条摘要（复用记忆提取的 result_note），
 * 避免几十条游戏问答把上下文挤爆。
 */
function mergeEndedGameMessages(msgs: ChatMessage[]): ChatMessage[] {
  const groups = new Map<number, ChatMessage[]>();
  for (const m of msgs) {
    if (!m.game_id) continue;
    const g = groups.get(m.game_id) ?? [];
    g.push(m);
    groups.set(m.game_id, g);
  }

  const result: ChatMessage[] = [];
  // 每个对局的 session 只查一次：原实现对每条游戏消息查一次库，
  // 而 getHistory 一轮对话会被调用多次，长对局会放大成上百次同步 SQLite 查询
  const sessionCache = new Map<number, ReturnType<typeof getGameSessionById>>();
  for (const m of msgs) {
    if (!m.game_id) {
      result.push(m);
      continue;
    }
    const group = groups.get(m.game_id)!;
    const isFirst = m.id === group[0].id;
    if (!sessionCache.has(m.game_id)) {
      sessionCache.set(m.game_id, getGameSessionById(m.game_id));
    }
    const session = sessionCache.get(m.game_id) ?? null;
    // result_note 只在对局结束时写入：即便旧数据 status 还卡在 playing，写了结果就当已结束
    if (!session || (session.status === "playing" && !session.result_note)) {
      result.push(m);
      continue;
    }
    if (isFirst) {
      // 摘要带「开始 ~ 结束」时间范围，并替换 [user] [ai] [time] 占位符
      // （result_note 存的是记忆体例原文，直接透传会把裸占位符带进上下文）
      const note = replacePlaceholders(
        session.result_note || "玩过一局游戏",
        session.started_at,
        getUserInfo(),
        dayjs()
      );
      result.push({
        id: `game_summary_${m.game_id}`,
        role: "system",
        content: `[游戏回顾] ${formatGameTimeRange(session.started_at, session.ended_at)} · ${note}`,
        timestamp: m.timestamp,
        is_game_summary: true,
      });
    }
  }
  return result;
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

      deleteMessagesByGameId: (gameId) =>
        set((state) => ({ messages: state.messages.filter((m) => m.game_id !== gameId) })),

      editMessage: (id, content) =>
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? { ...m, content } : m)),
        })),

      setLoading: (loading) => set({ isLoading: loading }),
      setStreamingText: (text) => set({ streamingText: text, streamingChunks: text ? [text] : [] }),
      appendStreamingText: (delta) =>
        set((state) => {
          const newText = state.streamingText + delta;
          // 与最终气泡同一套切割规则（splitForChat），
          // 否则流式阶段显示一整块、完成后突然切成多块，视觉上会跳
          return { streamingText: newText, streamingChunks: splitForChat(newText) };
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
        const { context_history_rounds } = getThresholds();
        const window = context_history_rounds * 2; // 每轮 = user + assistant
        const msgs = get().messages;
        // 把已结束对局的游戏对话合并成一条摘要，避免污染上下文
        const merged = mergeEndedGameMessages(msgs);
        // system 消息（游戏提示等）只用于 UI 展示，不进入模型上下文；
        // 但游戏摘要是有意进上下文的，标记 is_game_summary 保留。
        // 先过滤再截窗：放在 slice 之后过滤会让 system 消息占掉窗口名额，实际历史不足 N 轮
        const visible = merged.filter((m) => m.role !== "system" || m.is_game_summary);
        // 最后一条是 user（刚发送，AI 尚未回复）时，多取 1 条确保第一条是 user
        const lastRole = visible[visible.length - 1]?.role;
        const len = lastRole === "user" ? window + 1 : window;
        return visible.slice(-len);
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
