// ============================================================
// P3-4: Prompt 拼装与 Token 截断
//
// 架构：构建各段（系统人设、状态区、记忆区），分开返回便于缓存优化排列
//
// 超限时按权重从低到高剔除记忆区事件
// ============================================================

import { getFragmentsByEventId } from "@/db/queries";
import type {
  UserInfo,
  MemoryEvent,
  MemoryFragment,
  ChatMessage,
  DefaultPlaceholders,
} from "@/types/schema";
import { getPrompts, getPlaceholders } from "./config";
import { useSettingsStore } from "@/store/settingsStore";
import dayjs from "dayjs";

const DEFAULT_TOKEN_BUDGET = 8000; // 字符数作为 token 近似

export interface AssembledPrompt {
  /** 稳定部分：系统人设（不常变化，高缓存命中） */
  system: string;
  /** 易变部分：状态区（每次巩固可能变化） */
  state: string;
  /** 易变部分：记忆区（每次检索可能变化） */
  memory: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

/**
 * 拼装完整 Prompt
 *
 * 1. 构建各段内容（系统人设、状态区、记忆区）
 * 2. 分开返回，便于调用方按缓存策略排列
 * 3. 截断超预算的记忆事件
 */
export function assemblePrompt(
  userInfo: UserInfo | null,
  topEvents: (MemoryEvent & { live_weight: number })[],
  epiphany: MemoryEvent | null,
  chatHistory: ChatMessage[],
  emotion?: string,
  hitFragments?: Map<number, MemoryFragment[]>,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET
): AssembledPrompt {
  const prompts = getPrompts();
  const nickname = useSettingsStore.getState().user_nickname || "用户";

  // 1. 稳定部分：系统人设（替换 [user]）
  const systemPromptText = prompts.system_prompt.replace(/\[user\]/gi, nickname);

  // 2. 易变部分：状态区 + 记忆区（分开返回，便于缓存优化排列）
  const stateText = buildStateSection(userInfo, emotion);
  const memoryText = buildMemorySection(userInfo, topEvents, epiphany, hitFragments);

  // 3. 截断：若超预算，按权重从低到高剔除记忆事件
  const truncatedMemory = truncateToFit(memoryText, topEvents, epiphany, chatHistory, tokenBudget);

  // 4. 转换历史为 API 格式
  const messages = chatHistory.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  return { system: systemPromptText, state: stateText, memory: truncatedMemory, messages };
}

/**
 * 构建状态区 — 使用 state_injection_template 模板
 * 对齐原始文档：基础信息 + 偏好 + 社交图谱 + 心理状态 + 生活主线 + 情绪
 */
function buildStateSection(
  userInfo: UserInfo | null,
  emotion: string | undefined
): string {
  if (!userInfo) return "";

  const prompts = getPrompts();
  const template = prompts.state_injection_template;

  // 如果模板存在且包含 {{}} 占位符，使用模板渲染
  if (template && template.includes("{{")) {
    let result = renderStateTemplate(template, userInfo, emotion);
    // 替换通用变量 [now]
    if (result.includes("[now]")) {
      const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      const now = dayjs();
      result = result.replace(/\[now\]/g, `${now.format("M/D")}(${WEEKDAYS[now.day()]}) ${now.format("HH:mm")}`);
    }
    return result;
  }

  // 降级：手动拼接（兼容）
  const placeholders = getPlaceholders();
  const bi = userInfo.basic_identity;
  const p = placeholders;

  const parts: string[] = [];
  parts.push(`基础信息：${bi.nickname || p.nickname}，${bi.gender ? bi.gender + "，" : ""}${bi.birthday ? "出生于" + bi.birthday + "，" : ""}${bi.occupation || p.occupation}，所在地${bi.location || p.location}`);

  if (userInfo.preferences.likes.length > 0) {
    parts.push(`喜欢：${userInfo.preferences.likes.join("、")}`);
  }
  if (userInfo.preferences.dislikes.length > 0) {
    parts.push(`讨厌：${userInfo.preferences.dislikes.join("、")}`);
  }
  if (userInfo.social_graph.length > 0) {
    const graph = userInfo.social_graph
      .map((s) => `${s.name}(${s.role})：${s.attitude}`)
      .join("；");
    parts.push(`社交图谱：${graph}`);
  }
  if (userInfo.psycho_state.current_stressors.length > 0) {
    parts.push(`近期压力：${userInfo.psycho_state.current_stressors.join("、")}`);
  }
  if (userInfo.psycho_state.comm_preference) {
    parts.push(`沟通偏好：${userInfo.psycho_state.comm_preference || p.comm_preference}`);
  }
  if (userInfo.life_quests.long_term_goals.length > 0) {
    parts.push(`愿望：${userInfo.life_quests.long_term_goals.join("、")}`);
  }
  if (userInfo.life_quests.ongoing_tasks.length > 0) {
    const tasks = userInfo.life_quests.ongoing_tasks
      .map((t) => `${t.task_name}(${t.status})`)
      .join("；");
    parts.push(`待办：${tasks}`);
  }
  if (emotion) {
    parts.push(`当前情绪：${emotion}`);
  }

  return `## [用户信息]\n\n${parts.join("\n")}`;
}

/** 空值占位符，用于标记空字段以便后续整行移除 */
const EMPTY = "__EMPTY__";

/**
 * 使用 state_injection_template 模板渲染状态区
 * 替换 {{variable}} 占位符，空字段整行移除
 */
function renderStateTemplate(
  template: string,
  userInfo: UserInfo,
  emotion: string | undefined
): string {
  const bi = userInfo.basic_identity;
  const p = getPlaceholders();
  const ps = userInfo.psycho_state;
  const pref = userInfo.preferences;
  const sg = userInfo.social_graph;
  const lq = userInfo.life_quests;

  let result = template
    .replace(/\{\{nickname\}\}/g, bi.nickname || p.nickname)
    .replace(/\{\{gender\}\}/g, bi.gender || "")
    .replace(/\{\{birthday\}\}/g, bi.birthday || "")
    .replace(/\{\{occupation\}\}/g, bi.occupation || p.occupation)
    .replace(/\{\{location\}\}/g, bi.location || p.location)
    .replace(/\{\{likes\}\}/g, pref.likes.length > 0 ? pref.likes.join("、") : EMPTY)
    .replace(/\{\{dislikes\}\}/g, pref.dislikes.length > 0 ? pref.dislikes.join("、") : EMPTY)
    .replace(/\{\{comm_preference\}\}/g, ps.comm_preference || EMPTY)
    .replace(/\{\{personality_traits\}\}/g, ps.personality_traits.length > 0 ? ps.personality_traits.join("、") : EMPTY)
    .replace(/\{\{current_stressors\}\}/g, ps.current_stressors.length > 0 ? ps.current_stressors.join("、") : EMPTY)
    .replace(/\{\{long_term_goals\}\}/g, lq.long_term_goals.length > 0 ? lq.long_term_goals.join("、") : EMPTY)
    .replace(/\{\{emotion\}\}/g, emotion || EMPTY);

  // 社交图谱
  const graphText =
    sg.length > 0
      ? sg.map((s) => `${s.name}(${s.role})：${s.attitude}`).join("\n* ")
      : EMPTY;
  result = result.replace(/\{\{social_graph\}\}/g, graphText);

  // 待办任务
  const tasksText =
    lq.ongoing_tasks.length > 0
      ? lq.ongoing_tasks.map((t) => `${t.task_name}(${t.status})`).join("；")
      : EMPTY;
  result = result.replace(/\{\{ongoing_tasks\}\}/g, tasksText);

  // 移除包含空值占位符的行，以及空的段落标题
  return cleanEmptyLines(result);
}

/**
 * 渲染后清理：移除空值行和空段落标题
 * 两遍处理：第一遍标记要移除的行，第二遍检查空标题
 */
function cleanEmptyLines(text: string): string {
  const lines = text.split("\n");
  const removed = new Set<number>();

  // 第一遍：标记包含空值占位符的行
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(EMPTY)) {
      removed.add(i);
    }
  }

  // 辅助函数：找下一个未被移除的行
  function nextValidLine(from: number): string | null {
    for (let j = from + 1; j < lines.length; j++) {
      if (!removed.has(j)) return lines[j].trim();
    }
    return null;
  }

  // 第二遍：检查空段落标题
  for (let i = 0; i < lines.length; i++) {
    if (removed.has(i)) continue;
    const trimmed = lines[i].trim();
    if (trimmed.endsWith("：") || trimmed.endsWith(":")) {
      const nextLine = nextValidLine(i);
      if (!nextLine || nextLine.startsWith("**") || nextLine.startsWith("##") || nextLine.includes(EMPTY)) {
        removed.add(i);
      }
    }
  }

  // 收集未被移除的行
  const cleaned = lines.filter((_, i) => !removed.has(i));
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 构建记忆区 — 使用 memory_injection_template + memory_event_template 模板
 * 替换 [user] [time] 占位符
 * 命中事件显示所有关联片段，活跃事件显示最新一条片段摘要
 */
function buildMemorySection(
  userInfo: UserInfo | null,
  topEvents: (MemoryEvent & { live_weight: number })[],
  epiphany: MemoryEvent | null,
  hitFragments?: Map<number, MemoryFragment[]>
): string {
  const prompts = getPrompts();
  const eventTpl = prompts.memory_event_template;

  // 渲染每条事件
  const eventLines: string[] = [];
  for (const event of topEvents) {
    const text = replacePlaceholders(event.event_text, event.timestamp, userInfo);
    const line = eventTpl
      .replace(/\{\{weight\}\}/g, String(event.live_weight))
      .replace(/\{\{event_text\}\}/g, text);
    eventLines.push(line);

    // 如果是命中事件，显示所有关联片段
    const fragments = hitFragments?.get(event.id);
    if (fragments && fragments.length > 0) {
      for (const frag of fragments) {
        const fragText = replacePlaceholders(frag.summary, frag.timestamp, userInfo);
        eventLines.push(`  · ${fragText}`);
      }
    } else {
      // 活跃事件：获取最新一条片段摘要
      const eventFragments = getFragmentsByEventId(event.id);
      if (eventFragments.length > 0) {
        const latest = eventFragments[eventFragments.length - 1];
        const fragText = replacePlaceholders(latest.summary, latest.timestamp, userInfo);
        eventLines.push(`  · ${fragText}`);
      }
    }
  }

  // 渲染灵光一闪
  let epiphanyText = "";
  if (epiphany) {
    const text = replacePlaceholders(epiphany.event_text, epiphany.timestamp, userInfo);
    epiphanyText = `- [灵光一闪·冷记忆] ${text}`;
  }

  // 使用 memory_injection_template 拼装
  const template = prompts.memory_injection_template;
  if (template && template.includes("{{")) {
    let result = template
      .replace(/\{\{event_list\}\}/g, eventLines.join("\n") || "（暂无记忆事件）")
      .replace(/\{\{epiphany\}\}/g, epiphanyText);
    // 替换通用变量 [now]
    if (result.includes("[now]")) {
      const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      const now = dayjs();
      result = result.replace(/\[now\]/g, `${now.format("M/D")}(${WEEKDAYS[now.day()]}) ${now.format("HH:mm")}`);
    }
    return result;
  }

  // 降级：无模板时硬编码
  const lines: string[] = [];
  if (eventLines.length > 0) {
    lines.push("## 记忆区");
    lines.push(...eventLines);
  }
  if (epiphanyText) lines.push(epiphanyText);
  return lines.join("\n");
}

/**
 * 替换 [user]、[time]、[now] 占位符
 * [user] → 用户昵称
 * [time] → 相对时间描述（如"前两个月"、"上周"）
 * [now] → 当前时间（如"2026年7月17日 15:30"）
 */
function replacePlaceholders(
  text: string,
  eventTimestamp: string,
  userInfo: UserInfo | null
): string {
  let result = text;

  // [user] → 昵称
  const nickname = userInfo?.basic_identity?.nickname || "用户";
  result = result.replace(/\[user\]/g, nickname);

  // [time] → 相对时间
  if (result.includes("[time]") && eventTimestamp) {
    const eventTime = dayjs(eventTimestamp);
    const now = dayjs();
    const diffDays = now.diff(eventTime, "day");
    let relativeTime: string;

    if (diffDays < 1) {
      relativeTime = "今天";
    } else if (diffDays < 2) {
      relativeTime = "昨天";
    } else if (diffDays < 7) {
      relativeTime = `${diffDays}天前`;
    } else if (diffDays < 30) {
      const weeks = Math.floor(diffDays / 7);
      relativeTime = weeks <= 1 ? "上周" : `${weeks}周前`;
    } else if (diffDays < 365) {
      const months = Math.floor(diffDays / 30);
      relativeTime = months <= 1 ? "上个月" : `前${months}个月`;
    } else {
      const years = Math.floor(diffDays / 365);
      relativeTime = years <= 1 ? "去年" : `${years}年前`;
    }

    result = result.replace(/\[time\]/g, relativeTime);
  }

  // [now] → 当前时间
  if (result.includes("[now]")) {
    const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const now = dayjs();
    result = result.replace(/\[now\]/g, `${now.format("M/D")}(${WEEKDAYS[now.day()]}) ${now.format("HH:mm")}`);
  }

  return result;
}

/**
 * 截断策略：按权重从低到高依次剔除记忆区事件
 * 优先保护：系统人设 > 状态区 > 最近 15 轮对话 > 灵光一闪 > Top N 事件
 */
function truncateToFit(
  systemText: string,
  topEvents: (MemoryEvent & { live_weight: number })[],
  epiphany: MemoryEvent | null,
  chatHistory: ChatMessage[],
  budget: number
): string {
  const historyChars = chatHistory.reduce((sum, m) => sum + m.content.length, 0);
  const totalChars = systemText.length + historyChars;

  if (totalChars <= budget) return systemText;

  const excess = totalChars - budget;

  // 按权重从低到高排序记忆事件
  const sortedEvents = [...topEvents].sort((a, b) => a.live_weight - b.live_weight);

  // 构建事件行映射（行文本 → 长度）
  const lines = systemText.split("\n");
  const eventLineMap = new Map<string, number>();
  for (const line of lines) {
    if (line.startsWith("- ") && !line.startsWith("- [灵光一闪")) {
      eventLineMap.set(line, line.length);
    }
  }

  // 先尝试删除灵光一闪（如果存在且不是唯一记忆）
  let removed = 0;
  const removedLines = new Set<string>();
  if (epiphany && eventLineMap.size > 1) {
    for (const [line, len] of eventLineMap) {
      if (line.startsWith("- [灵光一闪")) {
        removedLines.add(line);
        removed += len;
        break;
      }
    }
  }

  // 按权重从低到高逐个删除事件行（通过事件文本匹配）
  const nickname = useSettingsStore.getState().user_nickname || "用户";
  for (const event of sortedEvents) {
    if (removed >= excess) break;
    const eventText = replacePlaceholders(event.event_text, event.timestamp, null);
    for (const [line, len] of eventLineMap) {
      if (line.includes(eventText) && !removedLines.has(line)) {
        removedLines.add(line);
        removed += len;
        break;
      }
    }
  }

  // 过滤掉被删除的行
  const result = lines.filter((line) => !removedLines.has(line)).join("\n");
  return result;
}

/**
 * 构建冷启动 Prompt — 对齐 PRD 2.1 节第 1 步
 * 冷启动 = 系统人设 + 冷启动模板（无状态区、无记忆区）
 */
export function buildColdStartPrompt(): { system: string; context: string } {
  const prompts = getPrompts();
  const nickname = useSettingsStore.getState().user_nickname || "用户";
  const systemPromptText = [
    prompts.system_prompt,
    prompts.cold_start_template,
  ]
    .filter(Boolean)
    .join("\n\n")
    .replace(/\[user\]/gi, nickname);

  // 冷启动时状态区和记忆区为空
  return { system: systemPromptText, context: "" };
}
