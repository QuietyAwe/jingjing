// ============================================================
// P3-4: Prompt 拼装与 Token 截断
//
// 架构：构建各段（系统人设、状态区、记忆区），分开返回便于缓存优化排列
//
// 超限时按权重从低到高剔除记忆区事件
// ============================================================

import { getFragmentsByEventIds, getUserInfo, activeStates, activeEvents } from "@/db/queries";
import type {
  UserInfo,
  MemoryEvent,
  MemoryFragment,
  ChatMessage,
  DefaultPlaceholders,
} from "@/types/schema";
import { getPrompts, getPlaceholders, getThresholds } from "./config";
import { DETAIL_VISIBLE_WEIGHT, calculateWeight } from "@/memory/decay";
import { useSettingsStore } from "@/store/settingsStore";
import { WEEKDAYS, formatNow, formatTodayLine } from "@/utils/holidays";
import { formatFriendRoster } from "@/friends/persona";
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
  epiphany: (MemoryEvent & { gist: string }) | null,
  chatHistory: ChatMessage[],
  currentStatus?: string,
  hitFragments?: Map<number, MemoryFragment[]>,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
  cuedFragmentIds?: Set<number>,
  friendCard?: FriendCardContext
): AssembledPrompt {
  const prompts = getPrompts();
  const nickname = getUserNickname(userInfo);
  const now = dayjs(); // 预计算当前时间，复用

  // 1. 稳定部分：系统人设（替换 [user]）
  const systemPromptText = prompts.system_prompt.replace(/\[user\]/gi, nickname);

  // 2. 易变部分：状态区 + 记忆区（分开返回，便于缓存优化排列）
  const stateText = buildStateSection(userInfo, currentStatus, now);
  const memoryBlocks = buildMemorySection(
    userInfo,
    topEvents,
    epiphany,
    hitFragments,
    cuedFragmentIds,
    friendCard
  );

  // 3. 转换历史为 API 格式（最后两条用户消息带时间戳，让 AI 感知时间流动）
  const messages = chatHistory.map((m) => {
    // 用户消息：最后两条带时间；AI 消息：不带时间（避免影响输出风格）
    const isUser = m.role === "user";
    const lastTwoUsers = chatHistory.filter((x) => x.role === "user").slice(-2);
    const showTime = isUser && m.timestamp && lastTwoUsers.some((x) => x.id === m.id);
    // 带周几（「10/7 周三 15:30」）：让 AI 知道这条消息发生在工作日还是周末
    const stamp = showTime ? dayjs(m.timestamp) : null;
    const timePrefix = stamp
      ? `[${stamp.format("M/D")} ${WEEKDAYS[stamp.day()]} ${stamp.format("HH:mm")}] `
      : "";
    return {
      // getHistory 会把已结束对局合并成一条 role:"system" 的 [游戏回顾] 摘要；
      // 若原样发出去，system 消息会卡在历史中段，部分 OpenAI 兼容端点会拒整请求。
      // 这里转成 user 注记（内容已带 [游戏回顾] 前缀），角色合法且语义清晰。
      role: (m.role === "system" ? "user" : m.role) as "user" | "assistant",
      content: timePrefix + m.content,
    };
  });

  // 4. 截断：预算覆盖全部四段，先降级/削记忆块，再丢最旧历史
  const fitted = truncateToFit({
    system: systemPromptText,
    state: stateText,
    memoryBlocks,
    messages,
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
    let result = renderStateTemplate(template, userInfo, currentStatus, currentTime);
    // 替换通用变量 [user]（状态区里指代用户，例如「被[user]叫醒了」）
    if (result.includes("[user]")) {
      result = result.replace(/\[user\]/g, getUserNickname(userInfo));
    }
    // 替换通用变量 [now] / [today]
    if (result.includes("[now]")) {
      result = result.replace(/\[now\]/g, formatNow(currentTime));
    }
    if (result.includes("[today]")) {
      result = result.replace(/\[today\]/g, formatTodayLine(currentTime));
    }
    return result;
  }

  // 降级：手动拼接（兼容）
  const placeholders = getPlaceholders();
  const bi = userInfo.basic_identity;
  const p = placeholders;

  const parts: string[] = [];
  parts.push(`基础信息：${bi.nickname || p.nickname}，${bi.gender ? bi.gender + "，" : ""}${bi.birthday ? "出生于" + bi.birthday + "，" : ""}${bi.occupation || p.occupation}，所在地${bi.location || p.location}`);

  if (userInfo.social_graph.length > 0) {
    const graph = userInfo.social_graph
      .map((s) => `${s.name}(${s.role})：${s.attitude}`)
      .join("；");
    parts.push(`社交图谱：${graph}`);
  }
  if (userInfo.traits.length > 0) {
    parts.push(`属性：${userInfo.traits.join("、")}`);
  }
  const states = activeStates(userInfo, currentTime);
  if (states.length > 0) {
    const lines = states
      .slice()
      .sort((a, b) => dayjs(b.created_at).valueOf() - dayjs(a.created_at).valueOf())
      .map((s) => `- ${replacePlaceholders(s.text, s.created_at, userInfo, currentTime)}`);
    parts.push(`近况：\n${lines.join("\n")}`);
  }
  const events = activeEvents(userInfo)
    .slice()
    .sort((a, b) => dayjs(a.due_time).valueOf() - dayjs(b.due_time).valueOf());
  if (events.length > 0) {
    const lines = events.map(
      (e) =>
        `- ${replacePlaceholders(e.text, e.created_at, userInfo, currentTime)}（${dayjs(e.due_time).format("M/D HH:mm")}）`
    );
    parts.push(`安排：\n${lines.join("\n")}`);
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
  currentStatus: string | undefined,
  now: dayjs.Dayjs
): string {
  const bi = userInfo.basic_identity;
  const p = getPlaceholders();

  let result = template
    .replace(/\{\{nickname\}\}/g, bi.nickname || p.nickname)
    .replace(/\{\{gender\}\}/g, bi.gender || "")
    .replace(/\{\{birthday\}\}/g, bi.birthday || "")
    .replace(/\{\{occupation\}\}/g, bi.occupation || p.occupation)
    .replace(/\{\{location\}\}/g, bi.location || p.location)
    .replace(/\{\{traits\}\}/g, userInfo.traits.length > 0 ? userInfo.traits.join("、") : EMPTY)
    .replace(/\{\{current_status\}\}/g, currentStatus || EMPTY)
    // 自己的熟人圈（不是用户的社交图谱）：低成本的在场感，让 AI 聊得起来
    .replace(/\{\{friends\}\}/g, formatFriendRoster(now) || EMPTY);

  // 社交图谱
  const graphText =
    userInfo.social_graph.length > 0
      ? userInfo.social_graph.map((s) => `${s.name}(${s.role})：${s.attitude}`).join("\n* ")
      : EMPTY;
  result = result.replace(/\{\{social_graph\}\}/g, graphText);

  // 近况（状态）：文本自带 [time] 占位符，按各自时间渲染成相对时间（「7天前开始发烧」）
  const states = activeStates(userInfo, now);
  const statesText =
    states.length > 0
      ? states
          .slice()
          .sort((a, b) => dayjs(b.created_at).valueOf() - dayjs(a.created_at).valueOf())
          .map((s) => replacePlaceholders(s.text, s.created_at, userInfo, now))
          .join("\n")
      : EMPTY;
  result = result.replace(/\{\{states\}\}/g, statesText);

  // 安排（事件）：带到期时间，按到期先后排
  const events = activeEvents(userInfo)
    .slice()
    .sort((a, b) => dayjs(a.due_time).valueOf() - dayjs(b.due_time).valueOf());
  const eventsText =
    events.length > 0
      ? events
          .map(
            (e) =>
              `${replacePlaceholders(e.text, e.created_at, userInfo, now)}（${dayjs(e.due_time).format("M/D HH:mm")}）`
          )
          .join("\n")
      : EMPTY;
  result = result.replace(/\{\{events\}\}/g, eventsText);

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
 * 记忆区的一个「块」：事件标题 + 它下面的片段行
 *
 * 每个块都备着 detail / brief 两个版本，Token 超预算时先降级再删除
 * （否则「要么全给要么全不给」，截断体验很硬）。
 */
export interface MemoryBlock {
  weight: number;
  isEpiphany: boolean;
  /** 完整注入内容 */
  detail: string;
  /** 降级注入内容（只留一句话印象） */
  brief: string;
  /** 当前是否已降级 */
  degraded: boolean;
}

/** 用户输入命中好友名时，前置注入的档案卡素材 */
export interface FriendCardContext {
  name: string;
  /** 人物小传（唯一定义，口吻/关系/看法都在里面） */
  profile: string;
  fragments: Array<{ summary: string; timestamp: string }>;
}

/**
 * 命中事件注入的片段条数上限
 *
 * 「被检索唤起」时应该给完整细节，但一个积累几十条片段的事件会一次撑爆预算，
 * 于是整块被截断、一条都留不下。取最近 3 条 + 最早 1 条，既有近因也有头绪。
 *
 * 被当前话题唤起的片段（cuedIds）必须入选——想不起来的细节可以省，
 * 刚想起来的那条不能省；超额时先丢「没被唤起且更旧」的。
 */
function capFragments(fragments: MemoryFragment[], cuedIds?: Set<number>): MemoryFragment[] {
  if (fragments.length <= 4) return fragments;
  const picked = new Map<number, MemoryFragment>();
  picked.set(fragments[0].id, fragments[0]);
  for (const f of fragments.slice(-3)) picked.set(f.id, f);
  if (cuedIds) for (const f of fragments) if (cuedIds.has(f.id)) picked.set(f.id, f);
  const list = [...picked.values()].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  if (list.length <= 4) return list;
  const droppable = list
    .filter((f) => !cuedIds?.has(f.id))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const dropIds = new Set(droppable.slice(0, list.length - 4).map((f) => f.id));
  return list.filter((f) => !dropIds.has(f.id));
}

/**
 * 详细/简略切换阈值：实时权重低于它的记忆整块只注入一句话 gist
 * 片段自身的 priority 参与：重大片段把阈值压低，
 * 也就是衰减到更低的权重才开始变模糊——重要的事确实会记得更久
 */
function detailThreshold(priority: number): number {
  const base = getThresholds().detail_visible_weight || DETAIL_VISIBLE_WEIGHT;
  return base * (priority >= 7 ? 0.6 : priority <= 3 ? 1.5 : 1);
}

/**
 * 构建记忆区 — 使用 memory_injection_template + memory_event_template 模板
 * 替换 [user] [time] 占位符
 *
 * 分层（模拟「记得很清楚」vs「只记得大概发生过这么件事」）：
 * - 命中事件**逐条**分层：被当前话题唤起的片段给完整 summary（刚想起来的细节），
 *   其余片段按各自年龄过遗忘曲线决定 summary/gist——想起一件事不会把整段往事全部擦亮
 * - 未命中事件按事件实时权重决定最新一条给 summary 还是 gist（整体熟悉感）
 */
function buildMemorySection(
  userInfo: UserInfo | null,
  topEvents: (MemoryEvent & { live_weight: number })[],
  epiphany: (MemoryEvent & { gist: string }) | null,
  hitFragments?: Map<number, MemoryFragment[]>,
  cuedFragmentIds?: Set<number>,
  friendCard?: FriendCardContext
): MemoryBlock[] {
  const prompts = getPrompts();
  const eventTpl = prompts.memory_event_template;
  const now = dayjs(); // 预计算当前时间，复用

  // 一次取回所有缺失片段，避免逐事件查询（N+1）
  const missingIds = topEvents
    .filter((e) => (hitFragments?.get(e.id)?.length ?? 0) === 0)
    .map((e) => e.id);
  const fallbackFragments = getFragmentsByEventIds(missingIds);

  const blocks: MemoryBlock[] = [];

  // 按名字命中的好友档案卡：回答「她是谁」用档案，回答「她说过什么」用片段，
  // 两者各司其职，不让记忆里的人和设定里的不是同一个人。
  // 权重置顶：档案是这一轮对话的前提，截断时最后才轮到它。
  if (friendCard) {
    // 小传是写给「好友自己」的第二人称文本，直接塞给主角会让人误以为是自己的想法：
    // 换掉人称段落标题，并明确「以下是 ta 的档案」
    const profile = replacePlaceholders(friendCard.profile, now.toISOString(), userInfo, now)
      .replace(/\[你对他们俩的看法\]/g, "[ta对他们俩的看法]")
      .replace(/\[你自己的日子\]/g, "[ta自己的日子]")
      .replace(/\[你的日子\]/g, "[ta的日子]");
    const fragLines = friendCard.fragments.map(
      (f) => `  · ${replacePlaceholders(f.summary, f.timestamp, userInfo, now)}`
    );
    const detail = [
      `【关于${friendCard.name}】以下是 ta 的档案，不是你的想法（档案里的「你」指 ta 自己）`,
      profile,
      ...(fragLines.length > 0 ? ["相关记忆：", ...fragLines] : []),
    ].join("\n");
    const brief = `【关于${friendCard.name}】${profile.replace(/\s+/g, " ").slice(0, 60)}`;
    blocks.push({ weight: 100, isEpiphany: false, detail, brief, degraded: false });
  }

  for (const event of topEvents) {
    const text = replacePlaceholders(event.event_text, event.timestamp, userInfo, now);
    const head = eventTpl
      .replace(/\{\{weight\}\}/g, String(event.live_weight))
      .replace(/\{\{event_text\}\}/g, text);

    const detailLines: string[] = [head];
    const briefLines: string[] = [head];
    let startDegraded = false;

    // 命中事件：逐条分层——被唤起的片段给完整 summary（刚想起来的细节），
    // 其余按各自年龄过遗忘曲线决定 summary/gist（想起一件事不会把整段往事全部擦亮）。
    // detail 已是逐条分层结果，整块不再降级；budget 截断时仍可退到全 gist 的 brief
    const fragments = hitFragments?.get(event.id);
    if (fragments && fragments.length > 0) {
      for (const frag of capFragments(fragments, cuedFragmentIds)) {
        const cued = cuedFragmentIds?.has(frag.id) ?? false;
        // 片段自身年龄权重：写入时刻≈经历时刻，priority 参与阈值（重大细节保持更久）
        const fragLive = calculateWeight(
          event.active_weight,
          frag.timestamp,
          frag.priority,
          event.memory_kind ?? "daily"
        );
        const vivid = cued || fragLive >= detailThreshold(frag.priority);
        const shortText = frag.gist || frag.summary.slice(0, 24);
        detailLines.push(
          `  · ${replacePlaceholders(vivid ? frag.summary : shortText, frag.timestamp, userInfo, now)}`
        );
        briefLines.push(`  · ${replacePlaceholders(shortText, frag.timestamp, userInfo, now)}`);
      }
    } else {
      const eventFragments = fallbackFragments.get(event.id);
      const latest = eventFragments?.[eventFragments.length - 1];
      if (!latest) continue;
      startDegraded = event.live_weight < detailThreshold(latest.priority);
      detailLines.push(`  · ${replacePlaceholders(latest.summary, latest.timestamp, userInfo, now)}`);
      briefLines.push(
        `  · ${replacePlaceholders(latest.gist || latest.summary.slice(0, 24), latest.timestamp, userInfo, now)}`
      );
    }

    blocks.push({
      weight: event.live_weight,
      isEpiphany: false,
      detail: detailLines.join("\n"),
      brief: briefLines.join("\n"),
      degraded: startDegraded,
    });
  }

  // 灵光一闪：连同一句印象一起注入，否则 AI 只拿到事件标题、接不上话
  if (epiphany) {
    const text = replacePlaceholders(epiphany.event_text, epiphany.timestamp, userInfo, now);
    const gist = epiphany.gist
      ? replacePlaceholders(epiphany.gist, epiphany.timestamp, userInfo, now)
      : "";
    const line = `- [灵光一闪·冷记忆] ${text}${gist && gist !== text ? `（${gist}）` : ""}`;
    blocks.push({ weight: 0, isEpiphany: true, detail: line, brief: line, degraded: false });
  }

  return blocks;
}

/**
 * 把记忆块渲染成注入文本
 * 使用 memory_injection_template 模板；无模板时降级为硬编码格式
 */
function renderMemoryBlocks(blocks: MemoryBlock[]): string {
  const prompts = getPrompts();
  const now = dayjs();
  const eventList = blocks.filter((b) => !b.isEpiphany);
  const epiphanyBlock = blocks.find((b) => b.isEpiphany);
  const render = (b: MemoryBlock) => (b.degraded ? b.brief : b.detail);

  const eventText = eventList.map(render).join("\n");
  const epiphanyText = epiphanyBlock ? render(epiphanyBlock) : "";

  const template = prompts.memory_injection_template;
  if (template && template.includes("{{")) {
    let result = template
      .replace(/\{\{event_list\}\}/g, eventText || "（暂无记忆事件）")
      .replace(/\{\{epiphany\}\}/g, epiphanyText);
    // 替换通用变量 [today] / [now]
    result = result
      .replace(/\[today\]/g, formatTodayLine(now))
      .replace(/\[now\]/g, formatNow(now));
    // 兜底：存量覆盖模板没放时间变量的，末尾补一行时间上下文——
    // 「今天是周几、放不放假」每轮都要让模型看到（模板自带 [now] 的尊重用户排版）
    if (!template.includes("[today]") && !template.includes("[now]")) {
      result += `\n\n---\n${formatTodayLine(now)}`;
    }
    return result;
  }

  // 降级：无模板时硬编码
  const lines: string[] = [];
  if (eventText) {
    lines.push("## 记忆区");
    lines.push(eventText);
  }
  if (epiphanyText) lines.push(epiphanyText);
  return lines.join("\n");
}

/**
 * 替换 [user]、[time]、[now] 占位符（记忆区与游戏回顾共用）
 * [user] → 用户昵称
 * [time] → 相对时间描述（如"前两个月"、"上周"）
 * [now] → 当前时间（如"2026年7月17日（周五）15:30"）
 */
export function replacePlaceholders(
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
    // 自然日差（与聊天页日期横幅 formatDateLabel 同口径）：
    // 昨晚的事今早看是「昨天」。此前用 24h 截断差，不足一天一律显示「今天」，
    // 昨天聊的事也被说成今天
    const diffDays = Math.max(
      0,
      currentTime.startOf("day").diff(eventTime.startOf("day"), "day")
    );
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
    result = result.replace(/\[now\]/g, formatNow(currentTime));
  }

  return result;
}

/**
 * 截断策略：预算覆盖「系统人设 + 状态区 + 记忆区 + 历史」
 *
 * 顺序（越靠后越伤体感，所以尽量往后放）：
 *   1. 删灵光一闪（锦上添花，最先让路）
 *   2. **先把低权重记忆块降级**（detail → brief，只留一句话）——别直接把整块抹掉
 *   3. 再按权重从低到高删除记忆块
 *   4. 仍超预算则丢弃最旧历史（至少保留最后一轮）
 */
function truncateToFit(params: {
  system: string;
  state: string;
  memoryBlocks: MemoryBlock[];
  messages: { role: "user" | "assistant"; content: string }[];
  budget: number;
}): { memory: string; messages: { role: "user" | "assistant"; content: string }[] } {
  const { system, state, memoryBlocks, messages, budget } = params;

  const systemTokens = estimateTokens(system);
  const stateTokens = estimateTokens(state);
  let keptMessages = messages;

  const measure = (blocks: MemoryBlock[], msgs: typeof messages) =>
    systemTokens +
    stateTokens +
    estimateTokens(renderMemoryBlocks(blocks)) +
    msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // 就地标记，避免截断过程中改动调用方传入的数组
  const blocks = memoryBlocks.map((b) => ({ ...b }));
  let total = measure(blocks, keptMessages);
  if (total <= budget) {
    return { memory: renderMemoryBlocks(blocks), messages: keptMessages };
  }

  const removed = new Set<MemoryBlock>();
  const dropBlock = (block: MemoryBlock) => {
    if (removed.has(block)) return false;
    removed.add(block);
    return true;
  };
  const alive = () => blocks.filter((b) => !removed.has(b));
  const remeasure = () => {
    total = measure(alive(), keptMessages);
    return total;
  };

  // 1. 灵光一闪优先删除（还有其它记忆时）
  const epi = blocks.find((b) => b.isEpiphany);
  if (epi && blocks.length > 1) {
    dropBlock(epi);
    if (remeasure() <= budget) {
      return { memory: renderMemoryBlocks(alive()), messages: keptMessages };
    }
  }

  // 2. 先降级：按权重从低到高，把 detail 换成 brief（一句话），而不是直接删掉
  const eventBlocks = blocks
    .filter((b) => !b.isEpiphany && !b.degraded)
    .sort((a, b) => a.weight - b.weight);
  for (const block of eventBlocks) {
    block.degraded = true;
    if (remeasure() <= budget) break;
  }

  // 3. 仍超预算：按权重从低到高整块删除
  for (const block of blocks.filter((b) => !b.isEpiphany).sort((a, b) => a.weight - b.weight)) {
    if (total <= budget) break;
    if (!dropBlock(block)) continue;
    remeasure();
  }

  // 4. 仍超预算：丢弃最旧历史（至少保留最后一轮）
  while (keptMessages.length > 2 && total > budget) {
    keptMessages = keptMessages.slice(1);
    remeasure();
  }

  return { memory: renderMemoryBlocks(alive()), messages: keptMessages };
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
