// ============================================================
// P4-1 + P4-4: 聊天主流程集成
// 用户输入 → 冷启动判断 → 检索 → Prompt 拼装 → LLM 调用
// ============================================================

import { getUserInfo, getMeta } from "@/db/queries";
import { retrieve } from "./retrieval";
import { buildEventNudges } from "./eventChecker";
import { assemblePrompt, buildColdStartPrompt } from "@/prompt/assembler";
import { logDebug } from "@/store/chatStore";
import { getThresholds } from "@/prompt/config";
import { resolveFriendMention } from "@/friends/persona";
import type { ChatMessage, UserInfo } from "@/types/schema";

/** 游戏注入：稳定段放记忆区之前，易变段放历史之后 */
export interface GameParts {
  /** 稳定：角色 + 规则 + 谜底（一局内不变，利于缓存） */
  section: string;
  /** 易变：本回合判定结果 / 剩余次数（放最后） */
  hint: string;
}

export interface ChatContext {
  /** 稳定部分：系统人设（高缓存命中） */
  systemPrompt: string;
  /** 易变部分：状态区 */
  statePrompt: string;
  /** 易变部分：记忆区 */
  memoryPrompt: string;
  /** 游戏区（进行中才有） */
  gamePrompt: string;
  /** 发送给 LLM 的消息数组 */
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  /** 是否为冷启动 */
  isColdStart: boolean;
  /** 检索到的关键词 */
  keywords: string[];
  /** 检索到的记忆事件数量 */
  memoryCount: number;
}

export interface ChatOptions {
  /** 重新生成 / 编辑重发：本轮不掷灵光一闪 */
  regenerate?: boolean;
}

/**
 * 构建聊天上下文 — 对齐 PRD 2.1 节完整流程
 *
 * @param userInput 用户输入文本
 * @param chatHistory 最近对话历史（已截断为 15 轮）
 */
export async function buildChatContext(
  userInput: string,
  chatHistory: ChatMessage[],
  game?: GameParts,
  options?: ChatOptions,
): Promise<ChatContext> {
  // 1. 冷启动检测
  const userInfo = getUserInfo();
  const isColdStart = !userInfo;

  // 2. 检索（AI 判定，失败或不可用时本地兜底）
  const { topEvents, epiphany, keywords, hitFragments, cuedFragmentIds, plan } =
    await retrieve(userInput, { skipEpiphany: Boolean(game) || Boolean(options?.regenerate) });
  // 本轮已召回的片段：按名字命中那几条不必再重复给
  const recalledFragmentIds = new Set<number>();
  for (const list of hitFragments.values()) for (const frag of list) recalledFragmentIds.add(frag.id);

  // 3. Prompt 拼装
  if (isColdStart) {
    // 冷启动：使用 cold_start_template
    const { system, today, context } = buildColdStartPrompt();
    // 冷启动没有人设/摘要/记忆区，也不走 token 预算测量：
    // 只带最近几轮，避免积压一堆还没巩固的消息把请求撑爆
    const recent = chatHistory.slice(-getThresholds().context_history_rounds * 2);
    // 冷启动无历史，结构：[system, today, game, ...history, gameHint]
    const messages = [
      { role: "system" as const, content: system },
      { role: "system" as const, content: today },
      ...(context ? [{ role: "system" as const, content: context }] : []),
      ...(game?.section ? [{ role: "system" as const, content: game.section }] : []),
      ...recent.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      ...(game?.hint ? [{ role: "system" as const, content: game.hint }] : []),
    ];
    logDebug("上下文", `冷启动模式\n消息数: ${messages.length}\nsystem 长度: ${system.length}`);
    return {
      systemPrompt: system,
      statePrompt: "",
      memoryPrompt: "",
      gamePrompt: "",
      messages,
      isColdStart: true,
      keywords,
      memoryCount: 0,
    };
  }

  // 用户提到某位好友的名字：前置一句「想起了谁」+ 最近几条相关记忆
  const mention = resolveFriendMention(userInput);
  // 已巩固的对话由滚动摘要代表：由 assemblePrompt 插在历史最前面
  const sessionDigest = getMeta("session_digest") ?? undefined;

  // 正常流程：拼装含状态区 + 记忆区的 prompt
  const assembled = assemblePrompt(
    userInfo,
    topEvents,
    epiphany,
    chatHistory,
    hitFragments,
    undefined, // tokenBudget 用默认值
    cuedFragmentIds,
    mention
      ? {
          fragments: mention.fragments
            .filter((f) => !recalledFragmentIds.has(f.id))
            .map((f) => ({
              summary: f.summary,
              timestamp: f.timestamp,
            })),
        }
      : undefined,
    sessionDigest,
    plan
  );

  const memoryCount = topEvents.length + (epiphany ? 1 : 0);

  // 事件提醒：临近/过期事件的隐形提示词，AI 在回复里自然提起/关心。
  // 对局中不注入——别让关心得知打断游戏节奏
  const eventNudge = game ? null : buildEventNudges(userInput);

  // Prompt 顺序：[system 人设][system 今天][system 状态区（用户侧）][摘要 + history（含状态注记）]
  //              [system 游戏区][system 记忆区][游戏提示][事件提醒]
  // 「今天」只到天、同一天内恒定；时刻由消息时间戳表达。
  // 游戏区和记忆区随话题变，留在历史后，一变不影响上面的历史
  const messages = [
    { role: "system" as const, content: assembled.system },
    { role: "system" as const, content: assembled.today },
    ...(assembled.state ? [{ role: "system" as const, content: assembled.state }] : []),
    ...assembled.messages,
    ...(game?.section ? [{ role: "system" as const, content: game.section }] : []),
    ...(assembled.memory ? [{ role: "system" as const, content: assembled.memory }] : []),
    ...(game?.hint ? [{ role: "system" as const, content: game.hint }] : []),
    ...(eventNudge ? [{ role: "system" as const, content: eventNudge }] : []),
  ];
  const trimmed = assembled.trimmed;
  const trimNote =
    [
      trimmed.droppedBlocks ? `删除记忆 ${trimmed.droppedBlocks} 块` : "",
      trimmed.degradedBlocks ? `降级记忆 ${trimmed.degradedBlocks} 块` : "",
      trimmed.overBudget > 0 ? `仍超 ${trimmed.overBudget} token（历史不裁）` : "",
    ]
      .filter(Boolean)
      .join(" / ") || "无";
  logDebug(
    "上下文",
    `正常模式${game ? "(游戏中)" : ""}, 记忆: ${memoryCount} 条, 摘要: ${sessionDigest ? `${sessionDigest.length} 字` : "无"}\n消息数: ${messages.length}\nsystem 长度: ${assembled.system.length}\nstate 长度: ${assembled.state.length}\nmemory 长度: ${assembled.memory.length}\n超出预算的裁剪: ${trimNote}`
  );
  return {
    systemPrompt: assembled.system,
    statePrompt: assembled.state,
    memoryPrompt: assembled.memory,
    gamePrompt: game?.section ?? "",
    messages,
    isColdStart: false,
    keywords,
    memoryCount,
  };
}
