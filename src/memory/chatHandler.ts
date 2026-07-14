// ============================================================
// P4-1 + P4-4: 聊天主流程集成
// 用户输入 → 冷启动判断 → 检索 → Prompt 拼装 → LLM 调用
// ============================================================

import { getUserInfo } from "@/db/queries";
import { retrieve } from "./retrieval";
import { assemblePrompt, buildColdStartPrompt } from "@/prompt/assembler";
import { getThresholds } from "@/prompt/config";
import type { ChatMessage, UserInfo } from "@/types/schema";

export interface ChatContext {
  /** 组装后的系统 prompt */
  systemPrompt: string;
  /** 发送给 LLM 的消息数组 */
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  /** 是否为冷启动 */
  isColdStart: boolean;
  /** 检索到的关键词 */
  keywords: string[];
  /** 检索到的记忆事件数量 */
  memoryCount: number;
}

/**
 * 构建聊天上下文 — 对齐 PRD 2.1 节完整流程
 *
 * @param userInput 用户输入文本
 * @param chatHistory 最近对话历史（已截断为 15 轮）
 */
export function buildChatContext(
  userInput: string,
  chatHistory: ChatMessage[]
): ChatContext {
  // 1. 冷启动检测
  const userInfo = getUserInfo();
  const isColdStart = !userInfo;

  // 2. 本地检索（PRD 2.1 节第 2-5 步）
  const { topEvents, epiphany, keywords } = retrieve(userInput);

  // 3. Prompt 拼装
  if (isColdStart) {
    // 冷启动：使用 cold_start_template 作为 system prompt
    const coldStartPrompt = buildColdStartPrompt();
    const messages = [
      { role: "system" as const, content: coldStartPrompt },
      ...chatHistory.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];
    return {
      systemPrompt: coldStartPrompt,
      messages,
      isColdStart: true,
      keywords,
      memoryCount: 0,
    };
  }

  // 正常流程：拼装含状态区 + 记忆区的 prompt
  const assembled = assemblePrompt(
    userInfo,
    topEvents,
    epiphany,
    chatHistory
  );

  return {
    systemPrompt: assembled.system,
    messages: assembled.messages,
    isColdStart: false,
    keywords,
    memoryCount: topEvents.length + (epiphany ? 1 : 0),
  };
}
