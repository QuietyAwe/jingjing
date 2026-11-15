// ============================================================
// 聊天状态（全量持久化）
// UI 显示全部历史，LLM 上下文见 getHistory（游标之后 + 会话摘要）
// ============================================================

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getGameSessionById, getUserInfo, getMeta } from "@/db/queries";
import { replacePlaceholders } from "@/prompt/assembler";
import { splitForChat } from "@/utils/text";
import type { ChatMessage } from "@/types/schema";
import dayjs from "dayjs";

export interface DebugLog {
  /** 单调递增，供列表定位（日志会滚动淘汰，id 不复用） */
  id: number;
  time: string;
  tag: string;
  text: string;
}

/** 日志 id 单调自增，清空日志后也不复用旧 id */
let debugLogSeq = 0;

/** 一次请求的 token 用量：cachedTokens 是其中命中前缀缓存的部分 */
export interface LlmUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/** 调试日志用的用量描述；没有用量时说明原因，不要显示成 0% */
export function formatUsage(usage: LlmUsage | null): string {
  if (!usage) return "缓存命中率 未知（本次会话还没有成功的请求）";
  const rate =
    usage.promptTokens > 0 ? Math.round((usage.cachedTokens / usage.promptTokens) * 100) : 0;
  return `缓存命中率 ${rate}%（${usage.cachedTokens}/${usage.promptTokens} prompt token）`;
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
  /** 最后一次请求的 token 用量（含前缀缓存命中，调试用，不持久化） */
  lastUsage: LlmUsage | null;
  /** API 请求/响应日志（调试用） */
  debugLogs: DebugLog[];

  addMessage: (msg: ChatMessage) => void;
  deleteMessage: (id: string) => void;
  /** 整局删除：移除该局游戏的全部消息（游戏合并卡片） */
  deleteMessagesByGameId: (gameId: number) => void;
  /** 清空与某位好友的私聊记录 */
  deleteMessagesByFriendId: (friendId: number) => void;
  editMessage: (id: string, content: string) => void;
  setLoading: (loading: boolean) => void;
  setStreamingText: (text: string) => void;
  appendStreamingText: (delta: string) => void;
  setStreamingThinking: (thinking: string) => void;
  appendStreamingThinking: (delta: string) => void;
  clearMessages: () => void;
  /** 存储调试信息 */
  setDebugInfo: (systemPrompt: string, keywords: string[], memoryCount: number) => void;
  /** 记录最后一次请求的用量 */
  setLastUsage: (usage: LlmUsage) => void;
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
      lastUsage: null,
      debugLogs: [],

      addMessage: (msg) =>
        set((state) => ({ messages: [...state.messages, msg] })),

      deleteMessage: (id) =>
        set((state) => ({ messages: state.messages.filter((m) => m.id !== id) })),

      deleteMessagesByGameId: (gameId) =>
        set((state) => ({ messages: state.messages.filter((m) => m.game_id !== gameId) })),

      deleteMessagesByFriendId: (friendId) =>
        set((state) => ({ messages: state.messages.filter((m) => m.friend_id !== friendId) })),

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
        set({ messages: [], streamingText: "", streamingChunks: [], streamingThinking: "", isLoading: false, lastSystemPrompt: "", lastKeywords: [], lastMemoryCount: 0, lastUsage: null, debugLogs: [] }),

      setDebugInfo: (systemPrompt, keywords, memoryCount) =>
        set({ lastSystemPrompt: systemPrompt, lastKeywords: keywords, lastMemoryCount: memoryCount }),

      setLastUsage: (usage) => set({ lastUsage: usage }),

      addDebugLog: (tag, text) =>
        set((state) => {
          const now = new Date();
          const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
          const id = ++debugLogSeq;
          const logs = [...state.debugLogs, { id, time, tag, text }];
          // 保留最近 100 条：判定一轮要写好几条（请求 / 返回 / 用量 / 结果），50 条只够十来轮
          return { debugLogs: logs.slice(-100) };
        }),

      clearDebugLogs: () => set({ debugLogs: [] }),

      /**
       * LLM 上下文
       *
       * 有会话摘要时只带「游标之后还没被摘要覆盖」的对话（摘要由 assemblePrompt 插在历史最前）；
       * 还没有摘要（首次使用 / 尚未巩固成功）时全量带上。
       *
       * 不做任何按轮数的截断：对话只在巩固推进游标、或 token 预算（truncateToFit）不够时才变短。
       * 按窗口从头切会让下一次请求的开头整体左移，前缀缓存全部失效，比省下的 token 更贵。
       */
      getHistory: () => {
        // 好友私聊是另一个空间：主聊天的上下文与记忆都不该看到它
        const msgs = get().messages.filter((m) => !m.friend_id);
        // 把已结束对局的游戏对话合并成一条摘要，避免污染上下文
        const merged = mergeEndedGameMessages(msgs);
        // system 消息（游戏提示等）只用于 UI 展示，不进入模型上下文；
        // 但游戏摘要是有意进上下文的，标记 is_game_summary 保留
        const visible = merged.filter((m) => m.role !== "system" || m.is_game_summary);

        if (!getMeta("session_digest")) return visible;

        // 摘要覆盖到巩固游标为止：之后的消息才是「还没被压缩过的原文」。
        // 锚点按 id 定位，消息被删时退化到时间戳
        const anchorId = getMeta("last_consolidated_id");
        const anchorAt = getMeta("last_consolidated_at");
        let pendingStart = 0;
        const anchorIdx = anchorId ? visible.findIndex((m) => m.id === anchorId) : -1;
        if (anchorIdx >= 0) {
          pendingStart = anchorIdx + 1;
        } else if (anchorAt) {
          const i = visible.findIndex((m) => m.timestamp > anchorAt);
          pendingStart = i < 0 ? visible.length : i;
        }
        let pending = visible.slice(pendingStart);
        // 被游标切掉的内容里，补回最近两局游戏回顾与最近两条状态注记：
        // 前者让 AI 记得刚玩过什么，后者让当下的情境还能被看见
        const past = visible.slice(0, pendingStart);
        const pastGameRecaps = past.filter((m) => m.is_game_summary).slice(-2);
        const pastStateNotes = past.filter((m) => m.is_state_note).slice(-2);
        const pastNotes = [...pastGameRecaps, ...pastStateNotes].sort((a, b) =>
          a.timestamp < b.timestamp ? -1 : 1
        );
        if (pastNotes.length > 0) pending = [...pastNotes, ...pending];

        // 游标刚好在末尾（极少见）：至少带上最后一轮，
        // 否则「重新生成」会拿不到待重发的用户消息
        if (pending.length === 0) return visible.slice(-2);
        // 历史以 user 开头更稳：部分 OpenAI 兼容端点对首条 assistant 的容忍度差
        if (pending[0]?.role === "assistant") pending = pending.slice(1);
        return pending;
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
