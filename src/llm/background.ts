// ============================================================
// P5-2: 后台提取 LLM 客户端
// 调用 gpt-4o-mini (JSON mode) 从对话快照中提取用户信息与记忆片段
// ============================================================

import { getClient } from "./client";
import { getPrompts, getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import dayjs from "dayjs";
import type {
  UserInfo,
  ConsolidationResponse,
  MemoryEvent,
  NewFragment,
  MomentAuthor,
  PostPlanDraft,
} from "@/types/schema";
import { MOOD_TAGS } from "@/types/schema";
import { activeStates, activeEvents } from "@/db/queries";
import type { ScheduleItem } from "@/db/queries";
import { stripIdentityKeywords } from "@/memory/identity";
import { ensureTimePlaceholder } from "@/utils/text";

/**
 * 归一化一条提取出来的片段：补齐缺失字段、夹紧取值范围
 * （LLM 偶尔漏字段，不能因此丢掉整次巩固）
 */
function normalizeFragment(raw: NewFragment): NewFragment {
  // 事发时间写死具体日期（如「10月10日」）的记忆过几天就成了错误信息，
  // 一律换回 [time] 占位符（渲染时输出「昨天/前天」等相对时间）
  const summary = ensureTimePlaceholder(raw.summary.trim());
  const priority = Number(raw.priority);
  return {
    summary,
    // gist 缺失时从 summary 截一句，保证分层渲染始终有「一句话」可用
    gist: ensureTimePlaceholder(raw.gist?.trim() || "") || summary.slice(0, 24),
    // 身份词（用户昵称 / AI 名称）不入库当关键词：每条记忆都有名字，命中没有区分度
    keywords: stripIdentityKeywords(
      (raw.keywords ?? []).map((k) => String(k).trim()).filter(Boolean)
    ).slice(0, 8),
    priority: Number.isFinite(priority) && priority >= 1 && priority <= 9 ? priority : 5,
    target_event_index: Number(raw.target_event_index) || -1,
    new_event_text: (raw.new_event_text ?? "").trim(),
  };
}

/**
 * 构建提取消息数组：系统指令 + 对话历史 + 提取请求
 * 对话历史作为独立消息发送，提高缓存命中率
 */
function buildExtractionMessages(
  userInfo: UserInfo,
  snapshot: Array<{ role: string; content: string }>,
  existingEvents: MemoryEvent[],
  eventFragments: Map<number, string[]>,
  asOf?: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const { extraction_prompt } = getPrompts();

  // 对话历史（作为独立消息）
  const historyMessages = snapshot.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // 提取请求（增量模式：只展示已有数组值，避免 LLM 重复提取）
  const lines: string[] = [
    extraction_prompt,
    "",
    "## 当前时间",
    // asOf = 这批对话实际发生的时刻（补巩固沿用历史对话时间），
    // 不传则用当前时间；显示本地时间，LLM 才能正确推断时段与 due_time 日期。
    // 否则几天前的对话会被当成「今天刚发生」提取
    dayjs(asOf).format("YYYY-MM-DD HH:mm:ss"),
    "⚠️ 这个时间只用于你推断相对时间和计算 events 的 due_time。",
    "gist / summary / states 里的事发时间必须写 [time] 占位符（系统会渲染成「昨天/前天」等相对时间）；绝对不要写「10月10日」这类具体日期，否则记忆过几天就是错的。",
    "",
    "## 已有数据（不需要重复提取）",
    `属性：${userInfo.traits.join("、") || "（无）"}`,
    `近况：${activeStates(userInfo).map((s) => s.text).join("、") || "（无）"}`,
    `事件：${activeEvents(userInfo)
      .map((e) => `${e.text}（到期 ${dayjs(e.due_time).format("YYYY-MM-DD HH:mm")}）`)
      .join("、") || "（无）"}`,
    `社交关系：${userInfo.social_graph.map(s => `${s.name}(${s.role})`).join("、") || "（无）"}`,
    "",
    "## 已有索引事件",
  ];

  if (existingEvents.length === 0) {
    lines.push("（暂无索引事件，请为本次对话创建新事件）");
  } else {
    for (const e of existingEvents) {
      lines.push(`- [id:${e.id}] ${e.event_text}`);
      const frags = eventFragments.get(e.id);
      if (frags) {
        for (const summary of frags) {
          lines.push(`  · ${summary}`);
        }
      }
    }
  }

  lines.push("");
  lines.push(
    '请严格输出 JSON，格式：{"new_info": {只写本次新发现的字段, 没有新信息的字段不要输出}, "new_fragments": [{"gist": "...", "summary": "...", "keywords": ["..."], "priority": 数字1-9, "target_event_index": 数字或-1, "new_event_text": ""}]}',
  );

  const requestMessage = {
    role: "user" as const,
    content: lines.join("\n"),
  };

  return [...historyMessages, requestMessage];
}

/**
 * 调用后台 LLM 提取用户信息与记忆片段
 */
export async function extractConsolidation(
  userInfo: UserInfo,
  snapshot: Array<{ role: string; content: string }>,
  existingEvents: MemoryEvent[],
  eventFragments: Map<number, string[]>,
  timeoutMs: number = 30000,
  asOf?: string,
): Promise<ConsolidationResponse | null> {
  const requestMessages = buildExtractionMessages(userInfo, snapshot, existingEvents, eventFragments, asOf);
  const routing = getModelRouting();
  const config = routing.background_extraction_config;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  logDebug("巩固请求", `模型: ${config.model}\n温度: ${config.temperature}\n快照: ${snapshot.length} 条\n消息数: ${requestMessages.length}\n\n=== 完整请求 ===\n${requestMessages.map((m, i) => `[${i}] ${m.role.toUpperCase()}\n${m.content.slice(0, 100)}...`).join("\n\n")}`);

  try {
    const client = getClient();
    const response = await client.chat.completions.create(
      {
        model: config.model,
        temperature: config.temperature,
        response_format: { type: "json_object" },
        // @ts-ignore: DeepSeek thinking 参数，提取默认开启
        thinking: { type: "enabled" },
        messages: requestMessages,
      },
      { signal: controller.signal },
    );

    clearTimeout(timer);

    const text = response.choices[0]?.message?.content;
    logDebug("巩固返回", `=== 完整响应 ===\n${text ?? "（空回复）"}`);
    if (!text) {
      return null;
    }

    const parsed = JSON.parse(text) as ConsolidationResponse;

    if (!parsed.new_info) {
      logDebug("巩固返回", `JSON 缺少 new_info\n${text.slice(0, 200)}`);
      return null;
    }

    // 兼容单条旧结构，统一归一成数组
    const rawList: NewFragment[] = [
      ...(Array.isArray(parsed.new_fragments) ? parsed.new_fragments : []),
      ...(parsed.new_fragment ? [parsed.new_fragment] : []),
    ];
    const fragments = rawList
      .filter((f) => f && typeof f.summary === "string" && f.summary.trim())
      .slice(0, 5) // 一次巩固最多 5 条，防止 LLM 把对话按句拆开刷爆片段表
      .map((f) => normalizeFragment(f));

    if (fragments.length === 0) {
      logDebug("巩固返回", `没有可用的片段\n${text.slice(0, 200)}`);
      return null;
    }
    parsed.new_fragments = fragments;
    // states 的事发时间同样必须是 [time]（渲染成相对时间），写死日期兜底换回
    if (parsed.new_info.states?.length) {
      parsed.new_info.states = parsed.new_info.states.map(ensureTimePlaceholder);
    }

    logDebug("巩固返回", `片段 ${fragments.length} 条\n${fragments.map((f) => `- ${f.gist}（P${f.priority}）`).join("\n")}`);
    return parsed;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      logDebug("巩固超时", `${timeoutMs}ms 已丢弃`);
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      logDebug("巩固失败", errMsg);
    }
    return null;
  }
}

/** 作息表 + 发帖计划的一次生成结果（同一请求两份产出） */
export interface ScheduleGenerationResult {
  schedule: ScheduleItem[];
  post_plan: PostPlanDraft[];
}

/**
 * 生成每周行为时间表 + 心情动态发帖计划
 * @param systemPrompt 系统人设提示词（AI 的人设）
 */
export async function generateSchedule(
  systemPrompt: string,
  lastWeekSchedule: ScheduleItem[],
  timeoutMs: number = 30000,
): Promise<ScheduleGenerationResult | null> {
  const { schedule_generation_prompt } = getPrompts();
  const routing = getModelRouting();
  const config = routing.background_extraction_config;

  // 构建上周时间表文本
  let lastWeekText = "（无上周时间表）";
  if (lastWeekSchedule.length > 0) {
    const lines: string[] = [];
    const dayLabels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    const slotLabels = ["早(6-9)", "上午(9-12)", "午(12-15)", "下午(15-18)", "晚(18-23)"];

    for (let day = 0; day < 7; day++) {
      const dayItems = lastWeekSchedule.filter(s => s.day_of_week === day);
      if (dayItems.length > 0) {
        lines.push(`${dayLabels[day]}：${dayItems.map(i => `${slotLabels[i.time_slot]}=${i.activity}`).join("，")}`);
      }
    }
    lastWeekText = lines.join("\n") || "（无上周时间表）";
  }

  const prompt = (schedule_generation_prompt || DEFAULT_SCHEDULE_PROMPT)
    .replace("{{persona}}", systemPrompt)
    .replace("{{last_week}}", lastWeekText);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestMessages = [
    { role: "system" as const, content: "你是一个生活规划引擎，只输出 JSON。" },
    { role: "user" as const, content: prompt },
  ];
  logDebug("时间表请求", `模型: ${config.model}\n\n=== 完整请求 ===\n${requestMessages.map((m, i) => `[${i}] ${m.role.toUpperCase()}\n${m.content}`).join("\n\n")}`);

  try {
    const client = getClient();
    const response = await client.chat.completions.create(
      {
        model: config.model,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: requestMessages,
      },
      { signal: controller.signal },
    );

    clearTimeout(timer);

    const text = response.choices[0]?.message?.content;
    logDebug("时间表返回", `=== 完整响应 ===\n${text ?? "（空回复）"}`);
    if (!text) return null;

    const parsed = JSON.parse(text) as {
      schedule?: Array<{ day: number; slot: number; activity: string }>;
      post_plan?: Array<{ day: number; slot: number; theme_hint: string }>;
    };
    if (!Array.isArray(parsed.schedule) || parsed.schedule.length === 0) {
      logDebug("时间表返回", "schedule 字段为空");
      return null;
    }

    // 验证并转换格式
    const items: ScheduleItem[] = parsed.schedule
      .filter(s => s.day >= 0 && s.day <= 6 && s.slot >= 0 && s.slot <= 4 && s.activity)
      .map(s => ({
        day_of_week: s.day,
        time_slot: s.slot,
        activity: s.activity.slice(0, 20),
      }));

    // 发帖计划：旧提示词/覆盖层可能没有 post_plan 字段，容错为空（调用方兜底）
    const postPlan: PostPlanDraft[] = (Array.isArray(parsed.post_plan) ? parsed.post_plan : [])
      .filter(p => p && p.day >= 0 && p.day <= 6 && p.slot >= 0 && p.slot <= 4 && p.theme_hint)
      .map(p => ({
        day_of_week: p.day,
        time_slot: p.slot,
        theme_hint: String(p.theme_hint).slice(0, 20),
      }));

    logDebug("时间表返回", `解析成功: 作息 ${items.length} 条，发帖计划 ${postPlan.length} 条`);
    return { schedule: items, post_plan: postPlan };
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      logDebug("时间表超时", `${timeoutMs}ms 已丢弃`);
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      logDebug("时间表失败", errMsg);
    }
    return null;
  }
}

const DEFAULT_SCHEDULE_PROMPT = `请根据以下人设信息，生成一份本周的行为时间表。

## 人设信息
{{persona}}

## 上周时间表（参考）
{{last_week}}

## 要求
1. 根据人设推断合理的日常作息
2. 工作日和周末要有区别
3. 活动描述简洁（20字以内），生活化
4. 可以有重复，但不要每天都完全一样
5. 周末可以安排休闲、社交活动

## 输出格式
JSON 对象，包含 schedule 数组，每个元素：
- day: 0-6（0=周一，6=周日）
- slot: 0-4（0=早6-9点，1=上午9-12点，2=午12-15点，3=下午15-18点，4=晚18-23点）
- activity: 活动描述（20字以内）

输出示例：
{"schedule": [{"day": 0, "slot": 0, "activity": "晨跑"}, ...]}`;

// ============================================================
// 心情动态：AI 发帖 / 评论文案生成
// ============================================================

/** AI 发帖生成结果 */
export interface MomentDraft {
  content: string;
  mood: string;
}

/** 发帖上下文 */
export interface MomentGenerationContext {
  /** 当前作息情境短语，如「下午，你刚看完书；今天已经晨跑」 */
  scene: string;
  /** 发帖计划里的主题/心情提示 */
  themeHint: string;
  /** 最近动态（双方，时间升序），避免重复、保持连贯 */
  recentMoments: Array<{ author: MomentAuthor; content: string; mood: string }>;
}

/** 把一条动态拼成 prompt 里的单行 */
function formatMomentLine(m: { author: MomentAuthor; content: string; mood: string }): string {
  return `${m.author === "ai" ? "你" : "[user]"}（${m.mood || "未标"}）：${m.content}`;
}

/** 把 LLM 输出的心情标签归一到固定集合，出错回退「平静」 */
function normalizeMood(raw: unknown): string {
  const mood = String(raw ?? "").trim();
  return (MOOD_TAGS as readonly string[]).includes(mood) ? mood : "平静";
}

/**
 * 生成一条 AI 心情动态（文案 + 心情标签）
 * JSON mode，失败/超时返回 null（调用方保留计划下轮重试或跳过）
 */
export async function generateMoment(
  systemPrompt: string,
  ctx: MomentGenerationContext,
  timeoutMs: number = 30000,
): Promise<MomentDraft | null> {
  const { moment_generation_prompt } = getPrompts();
  const routing = getModelRouting();
  const config = routing.background_extraction_config;

  const prompt = (moment_generation_prompt || "")
    .replace("{{persona}}", systemPrompt)
    .replace("{{scene}}", ctx.scene || "（照常的一天）")
    .replace("{{theme_hint}}", ctx.themeHint || "（没有特别想发的，随便发点什么）")
    .replace("{{recent}}", ctx.recentMoments.length > 0
      ? ctx.recentMoments.map(formatMomentLine).join("\n")
      : "（还没有发过动态）");

  const requestMessages = [
    { role: "system" as const, content: "你是一个动态文案生成引擎，只输出 JSON。" },
    { role: "user" as const, content: prompt },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  logDebug("动态生成请求", `模型: ${config.model}\n主题提示: ${ctx.themeHint}\n情境: ${ctx.scene}`);

  try {
    const client = getClient();
    const response = await client.chat.completions.create(
      {
        model: config.model,
        temperature: 0.9,
        response_format: { type: "json_object" },
        messages: requestMessages,
      },
      { signal: controller.signal },
    );

    clearTimeout(timer);

    const text = response.choices[0]?.message?.content;
    logDebug("动态生成返回", `=== 完整响应 ===\n${text ?? "（空回复）"}`);
    if (!text) return null;

    const parsed = JSON.parse(text) as { content?: string; mood?: string };
    const content = (parsed.content ?? "").trim();
    if (!content) return null;

    return { content: content.slice(0, 300), mood: normalizeMood(parsed.mood) };
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      logDebug("动态生成超时", `${timeoutMs}ms 已丢弃`);
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      logDebug("动态生成失败", errMsg);
    }
    return null;
  }
}

/** 评论生成上下文 */
export interface MomentCommentContext {
  /** 被评论的动态 */
  moment: { author: MomentAuthor; content: string; mood: string };
  /** 该动态下已有评论（时间升序） */
  comments: Array<{ author: MomentAuthor; content: string }>;
  /** 若有值表示回复这条用户评论；无值表示主动评论动态 */
  replyTo?: string;
}

/**
 * 生成 AI 在动态下的评论/回复（真人感短句）
 */
export async function generateMomentComment(
  systemPrompt: string,
  ctx: MomentCommentContext,
  timeoutMs: number = 30000,
): Promise<string | null> {
  const { moment_comment_prompt } = getPrompts();
  const routing = getModelRouting();
  const config = routing.background_extraction_config;

  const task = ctx.replyTo
    ? `回复 [user] 的这条评论：「${ctx.replyTo}」`
    : "给这条动态留一条你的评论";

  const prompt = (moment_comment_prompt || "")
    .replace("{{persona}}", systemPrompt)
    .replace("{{moment}}", formatMomentLine(ctx.moment))
    .replace("{{comments}}", ctx.comments.length > 0
      ? ctx.comments.map((c) => `${c.author === "ai" ? "你" : "[user]"}：${c.content}`).join("\n")
      : "（还没有评论）")
    .replace("{{task}}", task);

  const requestMessages = [
    { role: "system" as const, content: "你是一个评论文案生成引擎，只输出 JSON。" },
    { role: "user" as const, content: prompt },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  logDebug("评论生成请求", `模型: ${config.model}\n动态: ${ctx.moment.content.slice(0, 40)}\n任务: ${task}`);

  try {
    const client = getClient();
    const response = await client.chat.completions.create(
      {
        model: config.model,
        temperature: 0.9,
        response_format: { type: "json_object" },
        messages: requestMessages,
      },
      { signal: controller.signal },
    );

    clearTimeout(timer);

    const text = response.choices[0]?.message?.content;
    logDebug("评论生成返回", `=== 完整响应 ===\n${text ?? "（空回复）"}`);
    if (!text) return null;

    const parsed = JSON.parse(text) as { content?: string };
    const content = (parsed.content ?? "").trim();
    return content ? content.slice(0, 120) : null;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      logDebug("评论生成超时", `${timeoutMs}ms 已丢弃`);
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      logDebug("评论生成失败", errMsg);
    }
    return null;
  }
}
