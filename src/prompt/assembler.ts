// ============================================================
// P3-4: Prompt 拼装与 Token 截断
// 拼接顺序: 系统人设 + 状态区 + 记忆区 + 15 轮历史
// 超限时从低权重记忆事件开始剔除
// ============================================================

import type {
  UserInfo,
  MemoryEvent,
  ChatMessage,
  DefaultPlaceholders,
} from "@/types/schema";
import { getPrompts, getPlaceholders } from "./config";

const DEFAULT_TOKEN_BUDGET = 8000; // 字符数作为 token 近似

export interface AssembledPrompt {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

/**
 * 拼装完整 Prompt — 对齐 PRD 2.1 节第 6 步
 *
 * @param userInfo 当前用户信息（null = 冷启动）
 * @param topEvents Top 10 高权重记忆事件
 * @param epiphany 1 条随机冷记忆（可为 null）
 * @param chatHistory 最近对话历史（已截断为 15 轮）
 * @param emotion 当前情绪状态（可选）
 * @param tokenBudget 总字符预算
 */
export function assemblePrompt(
  userInfo: UserInfo | null,
  topEvents: (MemoryEvent & { live_weight: number })[],
  epiphany: MemoryEvent | null,
  chatHistory: ChatMessage[],
  emotion?: string,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET
): AssembledPrompt {
  const prompts = getPrompts();
  const placeholders = getPlaceholders();

  // 1. 系统人设
  const systemPrompt = prompts.system_prompt;

  // 2. 状态区
  const stateSection = buildStateSection(userInfo, emotion, placeholders);

  // 3. 记忆区（带截断）
  const memorySection = buildMemorySection(topEvents, epiphany);

  // 4. 组装系统部分
  const fullSystem = [systemPrompt, stateSection, memorySection]
    .filter(Boolean)
    .join("\n\n");

  // 5. 截断：若超预算，从低权重记忆事件开始剔除
  const truncated = truncateToFit(fullSystem, chatHistory, tokenBudget);

  // 6. 转换历史为 API 格式
  const messages = [
    { role: "user" as const, content: truncated.system },
    ...chatHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  return { system: truncated.system, messages };
}

/**
 * 构建状态区
 * 冷启动时应用 cold_start_template
 */
function buildStateSection(
  userInfo: UserInfo | null,
  emotion: string | undefined,
  placeholders: DefaultPlaceholders
): string {
  if (!userInfo) {
    // 冷启动：使用模板（已在 assemblePrompt 的 system prompt 中包含）
    return "";
  }

  const bi = userInfo.basic_identity;
  const p = placeholders;

  const parts: string[] = [];
  if (bi.nickname) parts.push(`${bi.nickname || p.nickname}`);
  if (bi.location) parts.push(`所在地${bi.location || p.location}`);
  if (bi.occupation) parts.push(`职业${bi.occupation || p.occupation}`);
  if (userInfo.psycho_state.comm_preference) {
    parts.push(`沟通风格：${userInfo.psycho_state.comm_preference || p.comm_preference}`);
  }
  if (userInfo.preferences.likes.length > 0) {
    parts.push(`喜欢：${userInfo.preferences.likes.join("、")}`);
  }
  if (userInfo.preferences.dislikes.length > 0) {
    parts.push(`不喜欢：${userInfo.preferences.dislikes.join("、")}`);
  }
  if (emotion) parts.push(`当前情绪：${emotion}`);

  return parts.length > 0 ? `## 用户状态\n${parts.join("；")}` : "";
}

/**
 * 构建记忆区
 * 包含 Top N 高权重事件 + 1 条灵光一闪
 */
function buildMemorySection(
  topEvents: (MemoryEvent & { live_weight: number })[],
  epiphany: MemoryEvent | null
): string {
  const lines: string[] = [];

  if (topEvents.length > 0) {
    lines.push("## 记忆区");
    for (const event of topEvents) {
      lines.push(`- [权重${event.live_weight}] ${event.event_text}`);
    }
  }

  if (epiphany) {
    lines.push(`- [灵光一闪·冷记忆] ${epiphany.event_text}`);
  }

  return lines.join("\n");
}

/**
 * 截断策略：超限时从低权重记忆事件开始剔除
 * 优先保护：系统人设 > 状态区 > 最近 15 轮对话 > 记忆区
 */
function truncateToFit(
  systemText: string,
  chatHistory: ChatMessage[],
  budget: number
): { system: string } {
  const historyChars = chatHistory.reduce((sum, m) => sum + m.content.length, 0);
  const totalChars = systemText.length + historyChars;

  if (totalChars <= budget) {
    return { system: systemText };
  }

  // 需要裁剪 systemText 的量
  const excess = totalChars - budget;

  // 从 systemText 的记忆区尾部开始逐行剔除
  const lines = systemText.split("\n");
  let removed = 0;
  const result: string[] = [];

  // 从尾部向前扫描记忆区的事件行
  let skipFromEnd = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("- [权重") && removed < excess) {
      removed += lines[i].length;
      skipFromEnd++;
    } else {
      break;
    }
  }

  // 保留去除尾部记忆事件后的部分
  if (skipFromEnd > 0) {
    return { system: lines.slice(0, lines.length - skipFromEnd).join("\n") };
  }

  return { system: systemText };
}

/**
 * 构建冷启动 Prompt — 对齐 PRD 2.1 节第 1 步
 */
export function buildColdStartPrompt(): string {
  const prompts = getPrompts();
  return prompts.cold_start_template;
}
