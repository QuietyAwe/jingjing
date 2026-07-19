// ============================================================
// P4-1 + P4-4: 聊天主流程集成
// 用户输入 → 冷启动判断 → 检索 → Prompt 拼装 → LLM 调用
// ============================================================

import { getUserInfo } from "@/db/queries";
import { retrieve } from "./retrieval";
import { assemblePrompt, buildColdStartPrompt } from "@/prompt/assembler";
import { getThresholds } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import { getCurrentStatus } from "./scheduler";
import type { ChatMessage, UserInfo } from "@/types/schema";

export interface ChatContext {
  /** 稳定部分：系统人设（高缓存命中） */
  systemPrompt: string;
  /** 易变部分：状态区 */
  statePrompt: string;
  /** 易变部分：记忆区 */
  memoryPrompt: string;
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
  chatHistory: ChatMessage[],
): ChatContext {
  // 1. 冷启动检测
  const userInfo = getUserInfo();
  const isColdStart = !userInfo;

  // 2. 本地检索（PRD 2.1 节第 2-5 步）
  const { topEvents, epiphany, keywords, hitFragments } = retrieve(userInput);

  // 获取当前状态（行为时间表）
  const currentStatus = getCurrentStatus() || undefined;

  // 3. Prompt 拼装
  if (isColdStart) {
    // 冷启动：使用 cold_start_template
    const { system, context } = buildColdStartPrompt();
    // 冷启动无历史，结构：[system, context]
    const messages = [
      { role: "system" as const, content: system },
      ...(context ? [{ role: "system" as const, content: context }] : []),
      ...chatHistory.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];
    logDebug("上下文", `冷启动模式\n消息数: ${messages.length}\nsystem 长度: ${system.length}`);
    return {
      systemPrompt: system,
      statePrompt: "",
      memoryPrompt: "",
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
    chatHistory,
    currentStatus,
    hitFragments
  );

  const memoryCount = topEvents.length + (epiphany ? 1 : 0);

  // Prompt 顺序：[system, state, memory, ...history]
  const messages = [
    { role: "system" as const, content: assembled.system },
    ...(assembled.state ? [{ role: "system" as const, content: assembled.state }] : []),
    ...(assembled.memory ? [{ role: "system" as const, content: assembled.memory }] : []),
    ...assembled.messages,
  ];
  logDebug("上下文", `正常模式, 记忆: ${memoryCount} 条\n消息数: ${messages.length}\nsystem 长度: ${assembled.system.length}\nstate 长度: ${assembled.state.length}\nmemory 长度: ${assembled.memory.length}`);
  return {
    systemPrompt: assembled.system,
    statePrompt: assembled.state,
    memoryPrompt: assembled.memory,
    messages,
    isColdStart: false,
    keywords,
    memoryCount,
  };
}
