// ============================================================
// P3-4: Prompt 拼装与 Token 截断
//
// 架构：构建各段（系统人设、状态区、记忆区），分开返回便于缓存优化排列
//
// 超限时按权重从低到高剔除记忆区事件
// ============================================================

import {
  getUserInfo,
  getActiveConditions,
  isConditionStale,
  getUpcomingEvents,
  getMeta,
} from "@/db/queries";
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
import { formatNow, formatTodayLine } from "@/utils/holidays";
import { listNameMatchFriends, matchFriendInText } from "@/friends/persona";
import dayjs from "dayjs";

/** 历史消息：摘要条带 is_digest 标记，截断时最后才丢 */
type HistoryMessage = { role: "user" | "assistant"; content: string; is_digest?: boolean };

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
  /**
   * 今天的时间锚点（日期 + 周几 + 假期/调休语义，不带时刻）
   * 同一天内恒定，作为独立 system 消息紧跟人设，让它在缓存前缀里
   */
  today: string;
  /** 状态区：只有用户那一侧的画像（两次巩固之间稳定） */
  state: string;
  /** 易变部分：记忆区（每次检索可能变化） */
  memory: string;
  messages: HistoryMessage[];
  /** 裁剪结果：降级/删了多少记忆块，以及裁完仍超出预算多少 token（历史不裁） */
  trimmed: { degradedBlocks: number; droppedBlocks: number; overBudget: number };
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
  hitFragments?: Map<number, MemoryFragment[]>,
  tokenBudget: number = getThresholds().context_token_budget,
  cuedFragmentIds?: Set<number>,
  friendMention?: FriendMentionContext,
  sessionDigest?: string
): AssembledPrompt {
  const prompts = getPrompts();
  const now = dayjs(); // 预计算当前时间，复用

  // 1. 稳定部分：系统人设（替换 [user] [ai]）+ 当天日期锚点
  const systemPromptText = applyIdentityPlaceholders(prompts.system_prompt, userInfo);
  // 日期只到「天」，放在最前面不会随时间变化而破坏缓存；时刻交给消息时间戳
  const todayText = formatTodayLine(now);

  // 2. 状态区：只有用户那一侧（相对稳定）；AI 自己的情境由历史里的状态注记提供
  const stateText = buildStateSection(userInfo, now);

  const memoryBlocks = buildMemorySection(
    userInfo,
    topEvents,
    epiphany,
    hitFragments,
    cuedFragmentIds,
    friendMention
  );

  // 3. 转换历史为 API 格式（用户消息一律带时间戳，AI 消息不带）
  //    不能只给「最后 N 条」带：上一轮的最末一条下一轮就变回无前缀，等于改写历史中段，
  //    前缀缓存从那条起全部失效。每条固定带时间，历史渲染结果就永不随轮次变化
  const historyMessages: HistoryMessage[] = chatHistory.map((m) => {
    const isUser = m.role === "user";
    const showTime = isUser && m.timestamp;
    const stamp = showTime ? dayjs(m.timestamp) : null;
    // 当天只写时刻（日期已由前置的「今天是…」说明）；更早的补日期，跨天也分得清。
    // 跨天那一刻前缀正好跟着日期锚点一起变，不额外多付一次缓存失效
    const timePrefix = stamp
      ? stamp.isSame(now, "day")
        ? `[${stamp.format("HH:mm")}] `
        : `[${stamp.format("M/D HH:mm")}] `
      : "";
    return {
      // getHistory 会把已结束对局合并成一条 role:"system" 的 [游戏回顾] 摘要；
      // 若原样发出去，system 消息会卡在历史中段，部分 OpenAI 兼容端点会拒整请求。
      // 这里转成 user 注记（内容已带 [游戏回顾] 前缀），角色合法且语义清晰。
      role: (m.role === "system" ? "user" : m.role) as "user" | "assistant",
      content: timePrefix + m.content,
    };
  });

  // 已巩固的对话由会话摘要代表：放在历史最前面，模型才知道「之前聊过什么」。
  // 占位符和完整日期都在注入时才渲染，库里保留原文供下次滚动压缩
  const digest = sessionDigest?.trim();
  const digestText = digest
    ? renderDigestDates(
        replacePlaceholders(digest, getMeta("session_digest_at") ?? now.toISOString(), userInfo, now),
        now
      )
    : "";
  const messages: HistoryMessage[] = digestText
    ? [{ role: "user", content: `[之前聊过] ${digestText}`, is_digest: true }, ...historyMessages]
    : historyMessages;

  // 4. 截断：预算覆盖全部四段，先降级/削记忆块，再丢最旧历史
  const fitted = truncateToFit({
    system: systemPromptText,
    today: todayText,
    state: stateText,
    memoryBlocks,
    messages,
    budget: tokenBudget,
  });

  return {
    system: systemPromptText,
    today: todayText,
    state: stateText,
    memory: fitted.memory,
    messages: fitted.messages,
    trimmed: fitted.trimmed,
  };
}

/**
 * 替换只认半角方括号，中文输入法却容易打出【user】：
 * 先把「全角括号 + 纯 ASCII 名字」归一成半角，中文解释性的【】原样保留
 */
export function normalizePlaceholders(text: string): string {
  return text.replace(/【([A-Za-z_]+)】/g, "[$1]");
}

/**
 * 身份占位符替换：[user] [ai]（系统人设、冷启动模板、状态区、好友小传共用）
 *
 * 凡是把可能含占位符的文本塞进提示词的地方都要过这一层：
 * 用户自定义的人设、模型写的好友小传里都带 [user]，不过滤就会原样泄漏给模型。
 */
export function applyIdentityPlaceholders(text: string, userInfo?: UserInfo | null): string {
  const nickname = getUserNickname(userInfo);
  const aiName = useSettingsStore.getState().ai_name || "私藏";
  return normalizePlaceholders(text)
    .replace(/\[user\]/gi, () => nickname)
    .replace(/\[ai\]/gi, () => aiName);
}

/**
 * 运行时占位符替换：[user] [ai] [now] [today]
 * 模板由用户自己编辑，这四种写法都必须生效，漏一种就会原样漏进提示词
 */
function applyRuntimePlaceholders(text: string, userInfo: UserInfo | null, now: dayjs.Dayjs): string {
  return applyIdentityPlaceholders(text, userInfo)
    .replace(/\[now\]/g, () => formatNow(now))
    .replace(/\[today\]/g, () => formatTodayLine(now));
}

/**
 * 构建状态区 — 使用 state_injection_template 模板
 * 结构：基础信息 + 社交图谱 + 属性 + 当前处境 + 安排
 */
function buildStateSection(
  userInfo: UserInfo | null,
  now?: dayjs.Dayjs
): string {
  if (!userInfo) return "";

  const prompts = getPrompts();
  const template = prompts.state_injection_template;
  const currentTime = now || dayjs();

  // 如果模板存在且包含 {{}} 占位符，使用模板渲染
  if (template && template.includes("{{")) {
    return applyRuntimePlaceholders(
      renderStateTemplate(template, userInfo, currentTime),
      userInfo,
      currentTime
    );
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
  const conditionsText = formatConditions(userInfo, currentTime);
  if (conditionsText) {
    parts.push(`当前处境：\n${conditionsText}`);
  }
  // 未来事件（timestamp 在未来的记忆事件），getUpcomingEvents 已按时刻升序
  const appointments = getUpcomingEvents();
  if (appointments.length > 0) {
    const lines = appointments.map(
      (e) =>
        `- ${replacePlaceholders(e.event_text, e.timestamp, userInfo, currentTime)}（${dayjs(e.timestamp).format("M/D HH:mm")}）`
    );
    parts.push(`安排：\n${lines.join("\n")}`);
  }
  return `## [用户信息]\n\n${parts.join("\n")}`;
}

/** 空值占位符，用于标记空字段以便后续整行移除 */
const EMPTY = "__EMPTY__";

/** 处境块最多注入几条：它是「影响此刻怎么说话」的少量信息，不是事件清单 */
const CONDITION_INJECT_LIMIT = 5;

/**
 * 当前处境（仍在持续的 condition 事件）：标签 + 从什么时候开始。
 * 超过耐心期限没再被提起的补一句「可能已经过去了」——数据还在，只是别当成一定还在
 */
function formatConditions(userInfo: UserInfo, now: dayjs.Dayjs): string {
  const conditions = getActiveConditions();
  if (conditions.length === 0) return "";
  return conditions
    .slice(0, CONDITION_INJECT_LIMIT)
    .map((c) => {
      const label = replacePlaceholders(c.event_text, c.timestamp, userInfo, now);
      const notes: string[] = [];
      const started = relativeDayLabel(c.timestamp, now);
      if (started) notes.push(`${started}开始的`);
      if (isConditionStale(c, now)) notes.push("可能已经过去了");
      return notes.length > 0 ? `- ${label}（${notes.join("，")}）` : `- ${label}`;
    })
    .join("\n");
}

/**
 * 使用 state_injection_template 模板渲染状态区
 * 替换 {{variable}} 占位符，空字段整行移除
 */
function renderStateTemplate(
  template: string,
  userInfo: UserInfo,
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
    // 老模板里可能还留着这两个变量：渲染成空行清掉，不漏原样文本
    .replace(/\{\{current_status\}\}/g, EMPTY)
    .replace(/\{\{friends\}\}/g, EMPTY);

  // 社交图谱
  const graphText =
    userInfo.social_graph.length > 0
      ? userInfo.social_graph.map((s) => `${s.name}(${s.role})：${s.attitude}`).join("\n* ")
      : EMPTY;
  result = result.replace(/\{\{social_graph\}\}/g, graphText);

  // 当前处境（仍在持续的 condition 事件）
  result = result.replace(/\{\{conditions\}\}/g, formatConditions(userInfo, now) || EMPTY);

  // 安排（未来事件）：timestamp 在未来，按发生时刻先后排
  const appointments = getUpcomingEvents();
  const eventsText =
    appointments.length > 0
      ? appointments
          .map(
            (e) =>
              `${replacePlaceholders(e.event_text, e.timestamp, userInfo, now)}（${dayjs(e.timestamp).format("M/D HH:mm")}）`
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
 * 记忆区的一个「块」：同一个事件下的若干片段行
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

/** 用户输入命中好友名时，前置注入的最近几条相关记忆 */
export interface FriendMentionContext {
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
 * 构建记忆区：只给本轮命中事件的片段，替换 [user] [time] 占位符
 *
 * 命中事件逐条分层：被当前话题唤起的片段给完整 summary，其余按各自年龄
 * 过遗忘曲线决定 summary/gist——想起一件事不会把整段往事全部擦亮
 */
function buildMemorySection(
  userInfo: UserInfo | null,
  topEvents: (MemoryEvent & { live_weight: number })[],
  epiphany: (MemoryEvent & { gist: string }) | null,
  hitFragments?: Map<number, MemoryFragment[]>,
  cuedFragmentIds?: Set<number>,
  friendMention?: FriendMentionContext
): MemoryBlock[] {
  const now = dayjs(); // 预计算当前时间，复用

  // 片段里第一次出现某位好友时，把一句关系接在名字后面；本轮不重复
  const nameMatchFriends = listNameMatchFriends();
  const hinted = new Set<string>();
  const withFriendHint = (line: string): string => {
    const hit = matchFriendInText(line, nameMatchFriends);
    if (!hit?.summary || hinted.has(hit.name)) return line;
    hinted.add(hit.name);
    return line.replace(hit.name, `${hit.name}（${hit.summary}）`);
  };

  const blocks: MemoryBlock[] = [];

  // 按名字命中：最近 4 条相关记忆，与其余记忆行同形（关系接在名字后面）
  // 权重置顶：这是这一轮对话的前提，截断时最后才轮到它
  if (friendMention) {
    const detail = friendMention.fragments
      .map((f) => `  · ${withFriendHint(anchorLine(f.summary, f.timestamp, userInfo, now))}`)
      .join("\n");
    if (detail) blocks.push({ weight: 100, isEpiphany: false, detail, brief: detail, degraded: false });
  }

  // 仍在持续的处境：处境块里已经有一行标签，这里只在被本轮话题命中时补细节
  const activeConditionIds = new Set(getActiveConditions().map((c) => c.id));

  for (const event of topEvents) {
    const hasHits = (hitFragments?.get(event.id)?.length ?? 0) > 0;
    if (activeConditionIds.has(event.id) && !hasHits) continue;

    const detailLines: string[] = [];
    const briefLines: string[] = [];
    // 命中事件：逐条分层——被唤起的片段给完整 summary（刚想起来的细节），
    // 其余按各自年龄过遗忘曲线决定 summary/gist（想起一件事不会把整段往事全部擦亮）。
    // detail 已是逐条分层结果，整块不再降级；budget 截断时仍可退到全 gist 的 brief
    const fragments = hitFragments?.get(event.id);
    if (!fragments || fragments.length === 0) continue;
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
        `  · ${withFriendHint(anchorLine(vivid ? frag.summary : shortText, frag.timestamp, userInfo, now))}`
      );
      briefLines.push(`  · ${withFriendHint(anchorLine(shortText, frag.timestamp, userInfo, now))}`);
    }

    // 已结束的处境：标题不显示时，把标注挂在首行片段
    if (event.memory_kind === "condition" && event.closed_at && detailLines.length > 0) {
      detailLines[0] += "（已经过去了）";
      briefLines[0] += "（已经过去了）";
    }

    blocks.push({
      weight: event.live_weight,
      isEpiphany: false,
      detail: detailLines.join("\n"),
      brief: briefLines.join("\n"),
      degraded: false,
    });
  }

  // 偶然想起的往事：只给一句印象，不带事件标题与机制标签
  if (epiphany) {
    const text = replacePlaceholders(epiphany.event_text, epiphany.timestamp, userInfo, now);
    const gist = epiphany.gist && epiphany.gist !== epiphany.event_text ? epiphany.gist : text;
    const line = `  · ${withFriendHint(anchorLine(gist, epiphany.timestamp, userInfo, now))}`;
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
  // 没有可注入的记忆时整块不出现
  if (blocks.length === 0) return "";
  const eventList = blocks.filter((b) => !b.isEpiphany);
  const epiphanyBlock = blocks.find((b) => b.isEpiphany);
  const render = (b: MemoryBlock) => (b.degraded ? b.brief : b.detail);

  const eventText = eventList.map(render).join("\n");
  const epiphanyText = epiphanyBlock ? render(epiphanyBlock) : "";

  const template = normalizePlaceholders(prompts.memory_injection_template);
  if (template && template.includes("{{")) {
    // [today] 仍可用（老模板里写着就照样渲染），但日期已经前置注入，
    // 默认模板不再放它，避免同一天两段一模一样的日期
    return template
      .replace(/\{\{event_list\}\}/g, eventText)
      .replace(/\{\{epiphany\}\}/g, epiphanyText)
      .replace(/\[today\]/g, formatTodayLine(now))
      .replace(/\[now\]/g, formatNow(now))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // 降级：无模板时只给内容
  return [eventText, epiphanyText].filter(Boolean).join("\n");
}

/**
 * 相对日标签：今天 / 昨天 / 3天前 / 上周 / 上个月 / 去年 / 2年前
 *
 * 按自然日差算（与聊天页日期横幅同口径）：昨晚的事今早看是「昨天」。
 * 约定类事件的 timestamp 在未来，同样要能读出「明天 / 3天后」——
 * 不能把负数 clamp 成 0，否则「下周三面试」会显示成「今天」。
 */
export function relativeDayLabel(timestamp: string | undefined, now: dayjs.Dayjs = dayjs()): string {
  if (!timestamp) return "";
  const eventTime = dayjs(timestamp);
  if (!eventTime.isValid()) return "";
  const diffDays = now.startOf("day").diff(eventTime.startOf("day"), "day");

  // 未来（约定）：明天 / N天后 / N周后 / N个月后
  if (diffDays < 0) {
    const ahead = -diffDays;
    if (ahead < 2) return "明天";
    if (ahead < 7) return `${ahead}天后`;
    if (ahead < 30) return `${Math.floor(ahead / 7)}周后`;
    if (ahead < 365) return `${Math.floor(ahead / 30)}个月后`;
    return `${Math.floor(ahead / 365)}年后`;
  }

  if (diffDays < 1) return "今天";
  if (diffDays < 2) return "昨天";
  if (diffDays < 7) return `${diffDays}天前`;
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return weeks <= 1 ? "上周" : `${weeks}周前`;
  }
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return months <= 1 ? "上个月" : `前${months}个月`;
  }
  const years = Math.floor(diffDays / 365);
  return years <= 1 ? "去年" : `${years}年前`;
}

/**
 * 会话摘要里的完整日期在注入时换成相对说法，库里原文不动。
 * 只认「26年11月14日」这种带两位年份、写到日的写法；月份写法和不带年份的日期不碰。
 */
export function renderDigestDates(text: string, now: dayjs.Dayjs = dayjs()): string {
  return text.replace(
    /(\d{2})年(\d{1,2})月(\d{1,2})日/g,
    (match, yy: string, mm: string, dd: string, offset: number, whole: string) => {
      // 四位年份里截出来的两位年份不是目标写法
      if (offset > 0 && /\d/.test(whole[offset - 1])) return match;
      const year = Math.floor(now.year() / 100) * 100 + Number(yy);
      const month = Number(mm);
      const day = Number(dd);
      const date = dayjs(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
      if (!date.isValid() || date.month() + 1 !== month || date.date() !== day) return match;
      return relativeDayLabel(date.format("YYYY-MM-DD"), now) || match;
    }
  );
}

/**
 * 记忆行的相对时间锚点：`3天前 …`
 *
 * 文本自带 [time] 时渲染出来就是相对时间，不再加前缀；
 * 没有 [time] 的（gist、老数据、模型漏写）由代码补齐，保证每行都看得出先后。
 */
export function anchorLine(raw: string, timestamp: string, userInfo: UserInfo | null, now: dayjs.Dayjs = dayjs()): string {
  const text = normalizePlaceholders(raw);
  const rendered = replacePlaceholders(text, timestamp, userInfo, now);
  if (text.includes("[time]")) return rendered;
  const label = relativeDayLabel(timestamp, now);
  return label ? `${label} ${rendered}` : rendered;
}

/**
 * 替换 [user]、[ai]、[time]、[now] 占位符（记忆区、状态区、游戏回顾共用）
 * [user] → 用户昵称
 * [ai] → AI 名称
 * [time] → 相对时间描述（如"前两个月"、"上周"）
 * [now] → 当前时间（如"2026年7月17日（周五）15:30"）
 */
export function replacePlaceholders(
  text: string,
  eventTimestamp: string,
  userInfo: UserInfo | null,
  now?: dayjs.Dayjs
): string {
  let result = normalizePlaceholders(text);
  const currentTime = now || dayjs();

  // [user] → 昵称
  const nickname = userInfo?.basic_identity?.nickname || "用户";
  result = result.replace(/\[user\]/gi, () => nickname);

  // [ai] → AI 名称
  const aiName = useSettingsStore.getState().ai_name || "私藏";
  result = result.replace(/\[ai\]/gi, () => aiName);

  // [time] → 相对时间
  if (result.includes("[time]") && eventTimestamp) {
    result = result.replace(/\[time\]/g, relativeDayLabel(eventTimestamp, currentTime));
  }

  // [now] → 当前时间
  if (result.includes("[now]")) {
    result = result.replace(/\[now\]/g, formatNow(currentTime));
  }

  return result;
}

/**
 * 按预算裁剪「系统人设 + 状态区 + 记忆区 + 历史」
 *
 * **历史一条都不删**：上下文里的历史全是游标之后、还没被巩固的对话，
 * 删掉就等于这段经历再也进不了记忆（已巩固的部分本来就由会话摘要代表，不在历史里）。
 * 所以超预算时只动记忆区，实在装不下就让这条请求超一点，并把超出量交回调用方记日志。
 *
 * 顺序：1. 删灵光一闪（锦上添花，最先让路）
 *       2. 低权重记忆块降级（detail → brief，只留一句话）——别直接把整块抹掉
 *       3. 按权重从低到高删除记忆块
 */
function truncateToFit(params: {
  system: string;
  today: string;
  state: string;
  memoryBlocks: MemoryBlock[];
  messages: HistoryMessage[];
  budget: number;
}): { memory: string; messages: HistoryMessage[]; trimmed: AssembledPrompt["trimmed"] } {
  const { system, today, state, memoryBlocks, messages, budget } = params;

  const systemTokens = estimateTokens(system) + estimateTokens(today);
  const stateTokens = estimateTokens(state);

  const measure = (blocks: MemoryBlock[], msgs: typeof messages) =>
    systemTokens +
    stateTokens +
    estimateTokens(renderMemoryBlocks(blocks)) +
    msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // 就地标记，避免截断过程中改动调用方传入的数组
  const blocks = memoryBlocks.map((b) => ({ ...b }));
  let total = measure(blocks, messages);
  if (total <= budget) {
    return {
      memory: renderMemoryBlocks(blocks),
      messages,
      trimmed: { degradedBlocks: 0, droppedBlocks: 0, overBudget: 0 },
    };
  }

  const removed = new Set<MemoryBlock>();
  const dropBlock = (block: MemoryBlock) => {
    if (removed.has(block)) return false;
    removed.add(block);
    return true;
  };
  const alive = () => blocks.filter((b) => !removed.has(b));
  const remeasure = () => {
    total = measure(alive(), messages);
    return total;
  };
  /** 收口并带上裁剪统计：调用方会打进调试日志 */
  const result = () => ({
    memory: renderMemoryBlocks(alive()),
    messages,
    trimmed: {
      degradedBlocks: blocks.filter((b) => b.degraded).length,
      droppedBlocks: removed.size,
      overBudget: Math.max(0, remeasure() - budget),
    },
  });

  // 1. 灵光一闪优先删除（还有其它记忆时）
  const epi = blocks.find((b) => b.isEpiphany);
  if (epi && blocks.length > 1) {
    dropBlock(epi);
    if (remeasure() <= budget) {
      return result();
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

  return result();
}

/**
 * 构建冷启动 Prompt — 对齐 PRD 2.1 节第 1 步
 * 冷启动 = 系统人设 + 冷启动模板（无状态区、无记忆区）
 */
export function buildColdStartPrompt(): { system: string; today: string; context: string } {
  const prompts = getPrompts();
  const systemPromptText = applyIdentityPlaceholders(
    [prompts.system_prompt, prompts.cold_start_template].filter(Boolean).join("\n\n")
  );

  // 冷启动没有状态区和记忆区，但日期锚点同样要前置
  return { system: systemPromptText, today: formatTodayLine(), context: "" };
}
