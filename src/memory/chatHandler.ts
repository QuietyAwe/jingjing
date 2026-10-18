// ============================================================
// P4-1 + P4-4: 聊天主流程集成
// 用户输入 → 冷启动判断 → 检索 → Prompt 拼装 → LLM 调用
// ============================================================

import { getUserInfo } from "@/db/queries";
import { retrieve } from "./retrieval";
import { buildEventNudges } from "./eventChecker";
import { assemblePrompt, buildColdStartPrompt } from "@/prompt/assembler";
import { getThresholds } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import { getCurrentScene, formatScene } from "./scheduler";
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

/**
 * 构建聊天上下文 — 对齐 PRD 2.1 节完整流程
 *
 * @param userInput 用户输入文本
 * @param chatHistory 最近对话历史（已截断为 15 轮）
 */
export function buildChatContext(
  userInput: string,
  chatHistory: ChatMessage[],
  game?: GameParts,
): ChatContext {
  // 1. 冷启动检测
  const userInfo = getUserInfo();
  const isColdStart = !userInfo;

  // 2. 本地检索（PRD 2.1 节第 2-5 步）
  const { topEvents, epiphany, keywords, hitFragments, cuedFragmentIds } = retrieve(userInput);

  // 获取 AI 当前情境（自己的作息），拼成自然的一句注入到 [你] 段落
  const scene = getCurrentScene();
  const currentStatus = scene ? formatScene(scene) : undefined;

  // 3. Prompt 拼装
  if (isColdStart) {
    // 冷启动：使用 cold_start_template
    const { system, context } = buildColdStartPrompt();
    // 冷启动无历史，结构：[system, game, ...history, gameHint]
    const messages = [
      { role: "system" as const, content: system },
      ...(context ? [{ role: "system" as const, content: context }] : []),
      ...(game?.section ? [{ role: "system" as const, content: game.section }] : []),
      ...chatHistory.map((m) => ({
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

  // 用户提到某位好友的名字：前置她的档案卡
  // （档案回答「她是谁」，片段回答「她说过什么」，不混为一谈）
  const mention = resolveFriendMention(userInput);

  // 正常流程：拼装含状态区 + 记忆区的 prompt
  const assembled = assemblePrompt(
    userInfo,
    topEvents,
    epiphany,
    chatHistory,
    currentStatus,
    hitFragments,
    undefined, // tokenBudget 用默认值
    cuedFragmentIds,
    mention
      ? {
          name: mention.friend.name,
          profile: mention.friend.profile,
          fragments: mention.fragments.map((f) => ({
            summary: f.summary,
            timestamp: f.timestamp,
          })),
        }
      : undefined
  );

  const memoryCount = topEvents.length + (epiphany ? 1 : 0);

  // 事件提醒：临近/过期事件的隐形提示词，AI 在回复里自然提起/关心。
  // 对局中不注入——别让关心得知打断游戏节奏
  const eventNudge = game ? null : buildEventNudges(userInput);

  // Prompt 顺序：[system, state, game, memory, ...history, gameHint, eventNudge]
  const messages = [
    { role: "system" as const, content: assembled.system },
    ...(assembled.state ? [{ role: "system" as const, content: assembled.state }] : []),
    ...(game?.section ? [{ role: "system" as const, content: game.section }] : []),
    ...(assembled.memory ? [{ role: "system" as const, content: assembled.memory }] : []),
    ...assembled.messages,
    ...(game?.hint ? [{ role: "system" as const, content: game.hint }] : []),
    ...(eventNudge ? [{ role: "system" as const, content: eventNudge }] : []),
  ];
  logDebug("上下文", `正常模式${game ? "(游戏中)" : ""}, 记忆: ${memoryCount} 条\n消息数: ${messages.length}\nsystem 长度: ${assembled.system.length}\nstate 长度: ${assembled.state.length}\nmemory 长度: ${assembled.memory.length}`);
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
