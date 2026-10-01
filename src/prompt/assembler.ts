// ============================================================
// P3-4: Prompt 拼装与 Token 截断
//
// 架构：构建各段（系统人设、状态区、记忆区），分开返回便于缓存优化排列
//
// 超限时按权重从低到高剔除记忆区事件
// ============================================================

import { getFragmentsByEventIds, getUserInfo } from "@/db/queries";
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

const DEFAULT_TOKEN_BUDGET = 8000; // token 近似值（见 estimateTokens）

/**
 * Token 估算：中日韩字符约 1 token/字，其余按 4 字符 ≈ 1 token
 * 比直接用字符数更接近真实计费，尤其是中文为主的场景
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    // 中日韩统一表意文字 + 假名 + 谚文 + 全角标点
    if (/[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch)) {
      cjk += 1;
    }
  }
  const rest = Math.max(0, text.length - cjk);
  return cjk + Math.ceil(rest / 4);
}

/**
 * 用户称呼的唯一来源：user_info.basic_identity.nickname
 * 优先使用已加载的画像，冷启动无画像时再查库
 */
function getUserNickname(userInfo?: UserInfo | null): string {
  return (
    userInfo?.basic_identity?.nickname ||
    getUserInfo()?.basic_identity?.nickname ||
    "用户"
  );
}

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
  currentStatus?: string,
  hitFragments?: Map<number, MemoryFragment[]>,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET
): AssembledPrompt {
  const prompts = getPrompts();
  const nickname = getUserNickname(userInfo);
  const now = dayjs(); // 预计算当前时间，复用

  // 1. 稳定部分：系统人设（替换 [user]）
  const systemPromptText = prompts.system_prompt.replace(/\[user\]/gi, nickname);

  // 2. 易变部分：状态区 + 记忆区（分开返回，便于缓存优化排列）
  const stateText = buildStateSection(userInfo, currentStatus, now);
  const memoryText = buildMemorySection(userInfo, topEvents, epiphany, hitFragments);

  // 3. 转换历史为 API 格式（最后两条用户消息带时间戳，让 AI 感知时间流动）
  const messages = chatHistory.map((m) => {
    // 用户消息：最后两条带时间；AI 消息：不带时间（避免影响输出风格）
    const isUser = m.role === "user";
    const lastTwoUsers = chatHistory.filter((x) => x.role === "user").slice(-2);
    const showTime = isUser && m.timestamp && lastTwoUsers.some((x) => x.id === m.id);
    const timePrefix = showTime
      ? `[${dayjs(m.timestamp).format("M/D HH:mm")}] `
      : "";
    return {
      role: m.role as "user" | "assistant",
      content: timePrefix + m.content,
    };
  });

  // 4. 截断：预算覆盖全部四段，先按权重削记忆，再丢最旧历史
  const fitted = truncateToFit({
    system: systemPromptText,
    state: stateText,
    memory: memoryText,
    messages,
    topEvents,
    epiphany,
    userInfo,
    budget: tokenBudget,
  });

  return {
    system: systemPromptText,
    state: stateText,
    memory: fitted.memory,
    messages: fitted.messages,
  };
}

/**
 * 构建状态区 — 使用 state_injection_template 模板
 * 对齐原始文档：基础信息 + 偏好 + 社交图谱 + 心理状态 + 生活主线 + 当前状态
 */
function buildStateSection(
  userInfo: UserInfo | null,
  currentStatus: string | undefined,
  now?: dayjs.Dayjs
): string {
  if (!userInfo) return "";

  const prompts = getPrompts();
  const template = prompts.state_injection_template;
  const currentTime = now || dayjs();

  // 如果模板存在且包含 {{}} 占位符，使用模板渲染
  if (template && template.includes("{{")) {
    let result = renderStateTemplate(template, userInfo, currentStatus);
    // 替换通用变量 [user]（状态区里指代用户，例如「被[user]叫醒了」）
    if (result.includes("[user]")) {
      result = result.replace(/\[user\]/g, getUserNickname(userInfo));
    }
    // 替换通用变量 [now]
    if (result.includes("[now]")) {
      const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      result = result.replace(/\[now\]/g, `${currentTime.format("M/D")}(${WEEKDAYS[currentTime.day()]}) ${currentTime.format("HH:mm")}`);
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
  const validTasks = userInfo.life_quests.ongoing_tasks.filter(t => t.task_name && t.status);
  if (validTasks.length > 0) {
    const tasks = validTasks
      .map((t) => `${t.task_name}(${t.status})`)
      .join("；");
    parts.push(`待办：${tasks}`);
  }
  if (currentStatus) {
    parts.push(`当前状态：${currentStatus}`);
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
  currentStatus: string | undefined
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
    .replace(/\{\{current_status\}\}/g, currentStatus || EMPTY);

  // 社交图谱
  const graphText =
    sg.length > 0
      ? sg.map((s) => `${s.name}(${s.role})：${s.attitude}`).join("\n* ")
      : EMPTY;
  result = result.replace(/\{\{social_graph\}\}/g, graphText);

  // 待办任务（过滤掉无效任务）
  const validTasks = lq.ongoing_tasks.filter(t => t.task_name && t.status);
  const tasksText =
    validTasks.length > 0
      ? validTasks.map((t) => `${t.task_name}(${t.status})`).join("；")
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
  const now = dayjs(); // 预计算当前时间，复用

  // 一次取回所有缺失片段，避免逐事件查询（N+1）
  const missingIds = topEvents
    .filter((e) => (hitFragments?.get(e.id)?.length ?? 0) === 0)
    .map((e) => e.id);
  const fallbackFragments = getFragmentsByEventIds(missingIds);

  // 渲染每条事件
  const eventLines: string[] = [];
  for (const event of topEvents) {
    const text = replacePlaceholders(event.event_text, event.timestamp, userInfo, now);
    const line = eventTpl
      .replace(/\{\{weight\}\}/g, String(event.live_weight))
      .replace(/\{\{event_text\}\}/g, text);
    eventLines.push(line);

    // 如果是命中事件，显示所有关联片段
    const fragments = hitFragments?.get(event.id);
    if (fragments && fragments.length > 0) {
      for (const frag of fragments) {
        const fragText = replacePlaceholders(frag.summary, frag.timestamp, userInfo, now);
        eventLines.push(`  · ${fragText}`);
      }
    } else {
      // 活跃事件：显示最新一条片段摘要
      const eventFragments = fallbackFragments.get(event.id);
      if (eventFragments && eventFragments.length > 0) {
        const latest = eventFragments[eventFragments.length - 1];
        const fragText = replacePlaceholders(latest.summary, latest.timestamp, userInfo, now);
        eventLines.push(`  · ${fragText}`);
      }
    }
  }

  // 渲染灵光一闪
  let epiphanyText = "";
  if (epiphany) {
    const text = replacePlaceholders(epiphany.event_text, epiphany.timestamp, userInfo, now);
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
  userInfo: UserInfo | null,
  now?: dayjs.Dayjs
): string {
  let result = text;
  const currentTime = now || dayjs();

  // [user] → 昵称
  const nickname = userInfo?.basic_identity?.nickname || "用户";
  result = result.replace(/\[user\]/g, nickname);

  // [ai] → AI 名称
  const aiName = useSettingsStore.getState().ai_name || "私藏";
  result = result.replace(/\[ai\]/g, aiName);

  // [time] → 相对时间
  if (result.includes("[time]") && eventTimestamp) {
    const eventTime = dayjs(eventTimestamp);
    const diffDays = currentTime.diff(eventTime, "day");
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
    result = result.replace(/\[now\]/g, `${currentTime.format("YYYY年M月D日")} ${WEEKDAYS[currentTime.day()]} ${currentTime.format("HH:mm")}`);
  }

  return result;
}

/**
 * 截断策略：按权重从低到高依次剔除记忆区事件
 * 优先保护：系统人设 > 状态区 > 最近 15 轮对话 > 灵光一闪 > Top N 事件
 */
interface MemoryBlock {
  start: number;
  end: number;
  text: string;
  isEpiphany: boolean;
  /** 匹配到的事件实时权重，未匹配或未染色时为 0 */
  weight: number;
}

/**
 * 将记忆区按 "- 事件行 + 其下的   片段行" 切块
 * 删除时整块移除，避免留下孤儿片段行
 */
function splitMemoryBlocks(lines: string[]): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];
  let current: MemoryBlock | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("- ")) {
      if (current) blocks.push(current);
      current = {
        start: i,
        end: i,
        text: line,
        isEpiphany: line.startsWith("- [灵光一闪"),
        weight: 0,
      };
    } else if (current && line.startsWith("  ")) {
      // 归属于上一个事件块的片段行
      current.end = i;
      current.text += `\n${line}`;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * 截断策略：预算覆盖「系统人设 + 状态区 + 记忆区 + 历史」
 * 顺序：优先删除灵光一闪 → 按实时权重从低到高删除记忆块 → 仍超则从最旧的历史开始丢弃
 */
function truncateToFit(params: {
  system: string;
  state: string;
  memory: string;
  messages: { role: "user" | "assistant"; content: string }[];
  topEvents: (MemoryEvent & { live_weight: number })[];
  epiphany: MemoryEvent | null;
  userInfo: UserInfo | null;
  budget: number;
}): { memory: string; messages: { role: "user" | "assistant"; content: string }[] } {
  const { system, state, memory, messages, topEvents, epiphany, userInfo, budget } = params;

  const systemTokens = estimateTokens(system);
  const stateTokens = estimateTokens(state);
  let keptMessages = messages;

  const measure = (memText: string, msgs: typeof messages) =>
    systemTokens +
    stateTokens +
    estimateTokens(memText) +
    msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  let total = measure(memory, keptMessages);
  if (total <= budget) return { memory, messages: keptMessages };

  // --- 第一步：按块删除记忆 ---
  const lines = memory.split("\n");
  const blocks = splitMemoryBlocks(lines);

  // 建立事件块到权重的映射：用渲染后的事件文本匹配 topEvents
  const weightByLine = new Map<string, number>();
  for (const event of topEvents) {
    const rendered = replacePlaceholders(event.event_text, event.timestamp, userInfo);
    weightByLine.set(rendered, event.live_weight);
  }
  for (const block of blocks) {
    if (block.isEpiphany) continue;
    const firstLine = block.text.split("\n")[0];
    for (const [rendered, weight] of weightByLine) {
      if (firstLine.includes(rendered)) {
        block.weight = weight;
        break;
      }
    }
  }

  const removedLines = new Set<number>();
  const dropBlock = (block: MemoryBlock) => {
    if (removedLines.has(block.start)) return false;
    for (let i = block.start; i <= block.end; i++) removedLines.add(i);
    return true;
  };

  const remainingMemory = () =>
    lines.filter((_, i) => !removedLines.has(i)).join("\n");

  // 灵光一闪优先删除（存在其它记忆时）
  if (epiphany && blocks.length > 1) {
    const epiphanyBlock = blocks.find((b) => b.isEpiphany);
    if (epiphanyBlock) {
      dropBlock(epiphanyBlock);
      total = measure(remainingMemory(), keptMessages);
    }
  }

  // 按权重从低到高删除事件块
  const eventBlocks = blocks
    .filter((b) => !b.isEpiphany)
    .sort((a, b) => a.weight - b.weight);

  for (const block of eventBlocks) {
    if (total <= budget) break;
    if (!dropBlock(block)) continue;
    total = measure(remainingMemory(), keptMessages);
  }

  // --- 第二步：记忆削完仍超预算，丢弃最旧的历史（至少保留最后一轮） ---
  if (total > budget) {
    while (keptMessages.length > 2 && total > budget) {
      keptMessages = keptMessages.slice(1);
      total = measure(remainingMemory(), keptMessages);
    }
  }

  return { memory: remainingMemory(), messages: keptMessages };
}

/**
 * 构建冷启动 Prompt — 对齐 PRD 2.1 节第 1 步
 * 冷启动 = 系统人设 + 冷启动模板（无状态区、无记忆区）
 */
export function buildColdStartPrompt(): { system: string; context: string } {
  const prompts = getPrompts();
  const nickname = getUserNickname();
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
