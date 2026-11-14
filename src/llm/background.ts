// ============================================================
// P5-2: 后台提取 LLM 客户端
// 调用 gpt-4o-mini (JSON mode) 从对话快照中提取用户信息与记忆片段
// ============================================================

import { getClient, hasApiKey } from "./client";
import { getPrompts, getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import dayjs from "dayjs";
import type {
  UserInfo,
  ConsolidationResponse,
  NewFragment,
  MomentAuthor,
  PostPlanDraft,
} from "@/types/schema";
import { MOOD_TAGS } from "@/types/schema";
import { getActiveConditions, getUpcomingEvents } from "@/db/queries";
import type { ScheduleItem } from "@/db/queries";
import { stripIdentityKeywords } from "@/memory/identity";
import { ensureTimePlaceholder } from "@/utils/text";
import { applyIdentityPlaceholders } from "@/prompt/assembler";

/**
 * 把要塞进提示词的文本先过一遍身份占位符：
 * 用户自定义的人设、模型写的好友小传都带 [user]/[ai]，不换就会原样漏给模型
 */
function fillIdentity(text: string): string {
  return applyIdentityPlaceholders(text);
}

/**
 * 归一化一条提取出来的片段：补齐缺失字段、夹紧取值范围
 * （LLM 偶尔漏字段，不能因此丢掉整次巩固）
 */
function normalizeFragment(raw: NewFragment): NewFragment {
  // 事发时间写死具体日期（如「10月10日」）的记忆过几天就成了错误信息，
  // 一律换回 [time] 占位符（渲染时输出「昨天/前天」等相对时间）
  const summary = ensureTimePlaceholder(raw.summary.trim());
  const priority = Number(raw.priority);
  // 未来才发生的事：发生时刻合法才保留，否则当普通记忆
  const rawHappensAt = typeof raw.happens_at === "string" ? raw.happens_at.trim() : "";
  const happensAt = rawHappensAt ? dayjs(rawHappensAt) : null;
  // 处境标签：去空白、限长；同时填「开始」和「结束」时以「还在持续」为准，
  // 因为误判成已结束会让 AI 直接忘掉用户当下的处境
  const condition = typeof raw.condition === "string" ? raw.condition.trim().slice(0, 12) : "";
  const conditionEnded =
    typeof raw.condition_ended === "string" ? raw.condition_ended.trim().slice(0, 12) : "";
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
    happens_at: happensAt?.isValid() ? happensAt.toISOString() : undefined,
    condition: condition || undefined,
    condition_ended: condition ? undefined : conditionEnded || undefined,
  };
}

/** 巩固时展示给模型的候选事件（片段保持原文，含 [time]/[user] 占位符，模型照此体例写） */
export interface CandidateEvent {
  id: number;
  title: string;
  snippets: string[];
  /** 这条事件是一个仍在持续的处境（模型据此判断该刷新还是该闭合） */
  condition?: boolean;
}

/** 相邻两条消息断开这么久就另起一段（固定值，不随设置页阈值变化） */
const HISTORY_SEGMENT_GAP_MINUTES = 30;

/** 巩固快照里的一条消息：时间只用来给历史分段 */
export interface ConsolidationMessage {
  role: string;
  content: string;
  timestamp?: string;
}

/**
 * 按「相邻两条有没有断开」分段，只在段首标一次时刻。
 * 标签用绝对时间；参照日取调用方传入的批末时间，同一批重试时不变，也不影响固定段的缓存前缀。
 */
function stampHistory(
  snapshot: ConsolidationMessage[],
  asOf?: string
): Array<{ role: "user" | "assistant"; content: string }> {
  // 参照日取批末消息时间，补记几天前的对话时「今天」才对得上
  const anchorDay = dayjs(asOf);
  let last: dayjs.Dayjs | null = null;
  return snapshot.map((m) => {
    const t = m.timestamp ? dayjs(m.timestamp) : null;
    let content = m.content;
    if (t?.isValid()) {
      if (!last || t.diff(last, "minute") >= HISTORY_SEGMENT_GAP_MINUTES) {
        const stamp = t.isSame(anchorDay, "day") ? t.format("HH:mm") : t.format("M/D HH:mm");
        content = `[${stamp}] ${content}`;
      }
      last = t;
    }
    return { role: m.role as "user" | "assistant", content };
  });
}

/**
 * 构建提取消息数组
 *
 * - [system] 固定提取规则 + 输出格式：每次完全一致，才能吃到前缀缓存；
 * - [history] 游标之后的新对话：不重复发已巩固内容，按断开分段、段首带时刻；
 * - [user] 动态块（当前时间 / 已有数据 / 上次摘要 / 候选事件 / 任务）：放最后。
 */
function buildExtractionMessages(
  userInfo: UserInfo,
  snapshot: ConsolidationMessage[],
  candidates: CandidateEvent[],
  sessionDigest: string | undefined,
  asOf?: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const { extraction_prompt } = getPrompts();

  // 固定段：规则 + 输出契约。改这里会让缓存前缀重建一次，别把动态值拼进来
  const systemPrompt = [
    extraction_prompt,
    "",
    "## 输出格式（严格 JSON）",
    '{"new_info": {只写本次新发现的字段，没有新信息的字段不要输出},',
    ' "new_fragments": [{"gist": "...", "summary": "...", "keywords": ["..."], "priority": 数字1-9, "target_event_index": 数字或-1, "new_event_text": "", "happens_at": "", "condition": "", "condition_ended": ""}],',
    ' "event_merges": [{"keep": 数字, "merge": [数字], "reason": "..."}],',
    ' "session_digest": "..."}',
  ].join("\n");

  const historyMessages = stampHistory(snapshot, asOf);

  // 动态块（增量模式：只展示已有数组值，避免 LLM 重复提取）
  const lines: string[] = [
    "## 当前时间",
    // asOf = 这批对话实际发生的时刻（分批消化时沿用历史对话时间），
    // 不传则用当前时间；显示本地时间，LLM 才能正确推断时段与 happens_at 日期。
    // 否则几天前的对话会被当成「今天刚发生」提取
    dayjs(asOf).format("YYYY-MM-DD HH:mm:ss"),
    "⚠️ 这是这批对话实际发生的时刻，用来推算会话摘要里的绝对日期和片段的 happens_at。",
    "记忆片段（gist / summary）的事发时间必须写 [time] 占位符，不要写具体日期；会话摘要 session_digest 例外，按第四节写绝对日期。",
    "历史消息开头的 [HH:mm] / [M/D HH:mm] 只标明这段话的时刻，用来判断事情先后与间隔，不是对话内容；不要把它写进片段，片段仍一律用 [time]。",
    "",
    "## 已有数据（不需要重复提取）",
    `属性：${userInfo.traits.join("、") || "（无）"}`,
    `当前处境：${getActiveConditions().map((e) => e.event_text).join("、") || "（无）"}`,
    `近期会发生的事：${getUpcomingEvents()
      .map((e) => `${e.event_text}（${dayjs(e.timestamp).format("YYYY-MM-DD HH:mm")}）`)
      .join("、") || "（无）"}`,
    `社交关系：${userInfo.social_graph.map(s => `${s.name}(${s.role})`).join("、") || "（无）"}`,
  ];

  if (sessionDigest?.trim()) {
    lines.push("", "## 上次摘要（供你更新，不是要提取的内容）", sessionDigest.trim());
  }

  lines.push("", "## 候选事件（与本轮话题相关，优先挂靠）");
  if (candidates.length === 0) {
    lines.push("（暂无相关事件，请为本次对话创建新事件）");
  } else {
    for (const c of candidates) {
      // 处境要标出来：模型得知道这条可以「接着提」（刷新）或「说好了」（闭合）
      lines.push(`- [id:${c.id}]${c.condition ? "[当前处境]" : ""} ${c.title}`);
      for (const snippet of c.snippets) lines.push(`  · ${snippet}`);
    }
  }

  lines.push(
    "",
    "## 任务",
    "按 system 里的规则提取 new_info、new_fragments、event_merges、session_digest。",
    "候选事件里如果有几条其实是同一段经历，用 event_merges 给出合并（keep 选信息最全的那条）；不确定就留空数组。",
    "片段优先挂靠候选事件；只有确实是新主题时才填 new_event_text。",
  );

  const requestMessage = {
    role: "user" as const,
    content: lines.join("\n"),
  };

  return [{ role: "system" as const, content: systemPrompt }, ...historyMessages, requestMessage];
}

/** 提取结果：失败必须带原因——它会进「连续失败」告警，用户要知道该修什么 */
export type ConsolidationExtraction =
  | { ok: true; data: ConsolidationResponse }
  | { ok: false; reason: string };

/**
 * 调用后台 LLM 提取用户信息与记忆片段
 */
export async function extractConsolidation(
  userInfo: UserInfo,
  snapshot: ConsolidationMessage[],
  candidates: CandidateEvent[],
  sessionDigest: string | undefined,
  timeoutMs: number = 30000,
  asOf?: string,
): Promise<ConsolidationExtraction> {
  // 没配 Key 时 getClient 会抛英文异常，这里给个能直接看懂的原因（会进连续失败告警）
  if (!hasApiKey()) {
    return { ok: false, reason: "还没配置 API Key" };
  }

  const requestMessages = buildExtractionMessages(userInfo, snapshot, candidates, sessionDigest, asOf);
  const routing = getModelRouting();
  const config = routing.background_extraction_config;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 固定段与动态块全文保留（排查「模型为什么这么归并/摘要」全靠它们），
  // 历史只给条数与首行：整段发出来会刷屏
  const systemPart = requestMessages[0]?.content ?? "";
  const dynamicPart = requestMessages[requestMessages.length - 1]?.content ?? "";
  const historyPart = requestMessages
    .slice(1, -1)
    .map((m, i) => `[${i}] ${m.role}: ${m.content.slice(0, 40)}...`)
    .join("\n");
  logDebug(
    "巩固请求",
    `模型: ${config.model}\n温度: ${config.temperature}\n快照: ${snapshot.length} 条 / 候选事件: ${candidates.length} 个 / 旧摘要: ${sessionDigest ? `${sessionDigest.length} 字` : "无"}\n\n=== system（${systemPart.length} 字）===\n${systemPart}\n\n=== 动态块（${dynamicPart.length} 字）===\n${dynamicPart}\n\n=== 历史 ${requestMessages.length - 2} 条 ===\n${historyPart}`
  );

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
      return { ok: false, reason: "模型返回空内容" };
    }

    let parsed: ConsolidationResponse;
    try {
      parsed = JSON.parse(text) as ConsolidationResponse;
    } catch {
      logDebug("巩固返回", `返回内容不是合法 JSON\n${text.slice(0, 200)}`);
      return { ok: false, reason: "返回内容不是合法 JSON" };
    }

    // 只更新摘要（没有新用户信息）也是合法返回，不能因缺 new_info 丢掉整包
    if (!parsed.new_info) {
      parsed.new_info = {};
    }

    const rawList: NewFragment[] = Array.isArray(parsed.new_fragments) ? parsed.new_fragments : [];
    const fragments = rawList
      .filter((f) => f && typeof f.summary === "string" && f.summary.trim())
      .slice(0, 8) // 一次巩固最多 8 条：chunk 变大后话题变多，但仍要防止按句拆开刷爆片段表
      .map((f) => normalizeFragment(f));

    // 归并决策：只留正整数 id，keep 不能出现在 merge 里，其余一律丢弃
    parsed.event_merges = (Array.isArray(parsed.event_merges) ? parsed.event_merges : [])
      .map((m) => {
        const keep = Number(m?.keep);
        const merge = (Array.isArray(m?.merge) ? m.merge : [])
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0 && n !== keep);
        return {
          keep,
          merge,
          reason: typeof m?.reason === "string" ? m.reason : undefined,
        };
      })
      .filter((m) => Number.isFinite(m.keep) && m.keep > 0 && m.merge.length > 0);

    // 会话摘要：空串视为没有（不能拿空值覆盖旧摘要）
    const digest = typeof parsed.session_digest === "string" ? parsed.session_digest.trim() : "";
    parsed.session_digest = digest ? digest.slice(0, 400) : undefined;

    // 片段和摘要都没有才算失败：纯闲聊也可能没有可提取的片段，但摘要仍要更新
    if (fragments.length === 0 && !parsed.session_digest) {
      logDebug("巩固返回", `没有可用的片段或摘要\n${text.slice(0, 200)}`);
      return { ok: false, reason: "返回里既没有片段也没有摘要" };
    }
    parsed.new_fragments = fragments;

    logDebug(
      "巩固返回",
      `片段 ${fragments.length} 条 / 归并 ${parsed.event_merges.length} 组 / 摘要 ${parsed.session_digest ? `${parsed.session_digest.length} 字` : "无"}\n${fragments.map((f) => `- ${f.gist}（P${f.priority}）`).join("\n")}`
    );
    return { ok: true, data: parsed };
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      logDebug("巩固超时", `${timeoutMs}ms 已丢弃`);
      return { ok: false, reason: `超时（${Math.round(timeoutMs / 1000)}s 无响应）` };
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug("巩固失败", errMsg);
    return { ok: false, reason: errMsg };
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
  /** 上周实况文本（有则优先于「上周计划」——实况才是习惯的证据） */
  lastWeekActuals?: string,
): Promise<ScheduleGenerationResult | null> {
  const { schedule_generation_prompt } = getPrompts();
  const routing = getModelRouting();
  const config = routing.background_extraction_config;

  // 构建上周时间表文本
  let lastWeekText = lastWeekActuals?.trim() || "（无上周时间表）";
  if (!lastWeekActuals?.trim() && lastWeekSchedule.length > 0) {
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
    .replace("{{persona}}", () => fillIdentity(systemPrompt))
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
  /** 随帖子一次生成的好友留言（未必有），调用方按名字找人、延迟落库 */
  friendComments: Array<{ name: string; content: string }>;
}

/** 发帖上下文 */
export interface MomentGenerationContext {
  /** 当前作息情境短语，如「下午，你刚看完书；今天已经晨跑」 */
  scene: string;
  /** 发帖计划里的主题/心情提示 */
  themeHint: string;
  /** 最近的共同经历（时间倒序，一行一件），只作情绪参考，不许复述细节 */
  memories: string[];
  /** 看到了这条动态的人（掷骰筛过的好友：名字 + 一句关系 + 小传），评论区只允许来自这些人 */
  friends: Array<{ name: string; summary: string; profile: string }>;
  /** 最近动态（时间升序），避免重复、保持连贯 */
  recentMoments: Array<{ author: MomentAuthor; content: string; mood: string; authorLabel?: string }>;
}

/** 把一条动态拼成 prompt 里的单行（authorLabel 用于好友等第三方署名） */
function formatMomentLine(m: {
  author: MomentAuthor;
  content: string;
  mood: string;
  authorLabel?: string;
}): string {
  // 调用方负责传真名；兜底也绝不能漏出 [user] 这种占位符
  const who = fillIdentity(m.authorLabel?.trim() || (m.author === "ai" ? "你" : "用户"));
  return `${who}（${m.mood || "未标"}）：${m.content}`;
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
    .replace("{{persona}}", () => fillIdentity(systemPrompt))
    .replace("{{scene}}", () => fillIdentity(ctx.scene || "（照常的一天）"))
    .replace("{{theme_hint}}", ctx.themeHint || "（没有特别想发的，随便发点什么）")
    .replace("{{memories}}", () =>
      ctx.memories.length > 0 ? ctx.memories.map((m) => `- ${m}`).join("\n") : "（最近没什么特别的）"
    )
    .replace("{{friends}}", () =>
      ctx.friends.length > 0
        ? ctx.friends
            .map(
              (f) =>
                `- ${fillIdentity(f.name)}${f.summary ? `（${fillIdentity(f.summary)}）` : ""}\n  ${fillIdentity(f.profile.replace(/\s+/g, " ")).slice(0, 160)}`
            )
            .join("\n")
        : "（这次没有别人看到）"
    )
    .replace("{{recent}}", () =>
      ctx.recentMoments.length > 0
        ? ctx.recentMoments.map(formatMomentLine).join("\n")
        : "（还没有发过动态）"
    );

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

    const parsed = JSON.parse(text) as {
      content?: string;
      mood?: string;
      friend_comments?: Array<{ name?: string; content?: string }>;
    };
    const content = (parsed.content ?? "").trim();
    if (!content) return null;

    // 只收名单里的人的留言：模型偶尔会自造名字，那些直接丢掉；一人一条，条数不设上限
    const allowed = new Set(ctx.friends.map((f) => f.name));
    const rawComments = Array.isArray(parsed.friend_comments) ? parsed.friend_comments : [];
    const seenNames = new Set<string>();
    const friendComments: Array<{ name: string; content: string }> = [];
    for (const item of rawComments) {
      const name = String(item?.name ?? "").trim();
      const body = String(item?.content ?? "").trim();
      if (!body || !allowed.has(name) || seenNames.has(name)) continue;
      seenNames.add(name);
      friendComments.push({ name, content: body.slice(0, 120) });
    }

    return {
      content: content.slice(0, 300),
      mood: normalizeMood(parsed.mood),
      friendComments,
    };
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

// ============================================================
// 每日实况：日生成（基线 + 昨夜 + 节假日 + 伪天气 + 用户在场）
// ============================================================

export interface DailyLifeInput {
  /** 如「10月18日（周日）」 */
  date: string;
  /** 如「周末」「国庆节假期」「调休上班」 */
  dayContext: string;
  weather: string;
  /** 今天在周表里的 5 格习惯 */
  baseline: string;
  /** 昨天实际发生的事 */
  yesterday: string;
  /** 今天凌晨（0-6 点）的状态 */
  lateNight: string;
  /** 和用户有关的事 */
  userContext: string;
}

export interface DailyLifeDraft {
  mood: string;
  highlight: string;
  /** 固定长度 5，空串表示该时段留白 */
  slots: string[];
}

/**
 * 生成今天的实况。
 * 失败/超时返回 null，调用方回退周基线表（不写库，下次轮询重试）。
 */
export async function generateDailyLife(
  systemPrompt: string,
  ctx: DailyLifeInput,
  timeoutMs: number = 30000
): Promise<DailyLifeDraft | null> {
  const { daily_life_generation_prompt } = getPrompts();
  if (!daily_life_generation_prompt) return null;

  // 模板正文里的「和[user]有关的事」也要换成昵称：整段再过滤一遍
  const prompt = fillIdentity(
    daily_life_generation_prompt
      .replace("{{persona}}", () => fillIdentity(systemPrompt))
      .replace("{{date}}", ctx.date)
      .replace("{{day_context}}", ctx.dayContext)
      .replace("{{weather}}", ctx.weather)
      .replace("{{baseline}}", ctx.baseline)
      .replace("{{yesterday}}", ctx.yesterday)
      .replace("{{late_night}}", ctx.lateNight)
      .replace("{{user_context}}", ctx.userContext)
  );

  const parsed = await requestBackgroundJson(prompt, timeoutMs, "每日实况", 0.8);
  if (!parsed) return null;

  const rawSlots = Array.isArray(parsed.slots) ? parsed.slots : [];
  const slots: string[] = ["", "", "", "", ""];
  for (const item of rawSlots) {
    if (!item || typeof item !== "object") continue;
    const slot = Number((item as { slot?: unknown }).slot);
    const activity = String((item as { activity?: unknown }).activity ?? "").trim();
    if (!Number.isInteger(slot) || slot < 0 || slot > 4) continue;
    // 一格可以跨到下一格（「一整个下午都在弄同一件事」），但不做强制填充
    slots[slot] = activity.slice(0, 80);
  }

  if (!slots.some(Boolean)) {
    logDebug("每日实况返回", "没有任何时段内容，回退基线");
    return null;
  }

  return {
    mood: normalizeMood(parsed.mood),
    highlight: String(parsed.highlight ?? "").trim().slice(0, 20),
    slots,
  };
}

// ============================================================
// AI 熟人圈：花名册 / 好友发帖 / 好友评论
// ============================================================

export interface FriendRosterInput {
  persona: string;
  scene: string;
  userContext: string;
  preferences: string;
  count: number;
}

export interface FriendRosterDraft {
  name: string;
  avatar_emoji: string;
  summary: string;
  profile: string;
}

/** 生成一批固定好友（一次调用产出完整名单，之后稳定复用） */
export async function generateFriendRoster(
  ctx: FriendRosterInput,
  timeoutMs: number = 45000
): Promise<FriendRosterDraft[]> {
  const { friend_persona_generation_prompt } = getPrompts();
  if (!friend_persona_generation_prompt) return [];

  const prompt = friend_persona_generation_prompt
    .replace("{{persona}}", () => fillIdentity(ctx.persona))
    .replace("{{scene}}", () => fillIdentity(ctx.scene || "（平常的一天）"))
    .replace("{{user_context}}", () => fillIdentity(ctx.userContext || "（还不了解[user]）"))
    .replace("{{preferences}}", () => fillIdentity(ctx.preferences || "（[user]没有特别要求）"))
    .replace("{{count}}", String(ctx.count));

  const parsed = await requestBackgroundJson(prompt, timeoutMs, "好友花名册", 1.0);
  if (!parsed) return [];

  const rawList = Array.isArray(parsed.friends) ? parsed.friends : [];
  const out: FriendRosterDraft[] = [];
  const seenNames = new Set<string>();

  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = String(r.name ?? "").trim().slice(0, 12);
    const profile = String(r.profile ?? "").trim();
    if (!name || !profile) continue;
    // 同名只留一个：花名册里出现两个「小雨」会直接让人出戏
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    out.push({
      name,
      avatar_emoji: String(r.avatar_emoji ?? "").trim().slice(0, 4) || name.slice(0, 1),
      summary: String(r.summary ?? "").trim().slice(0, 24),
      profile: profile.slice(0, 600),
    });
  }
  return out;
}

export interface FriendMomentContext {
  friendName: string;
  profile: string;
  scene: string;
  recent: Array<{ author: string; content: string; mood: string }>;
}

/** 好友发一条动态（口吻完全由小传决定） */
export async function generateFriendMoment(
  ctx: FriendMomentContext,
  timeoutMs: number = 30000
): Promise<{ content: string; mood: string } | null> {
  const { friend_moment_generation_prompt } = getPrompts();
  if (!friend_moment_generation_prompt) return null;

  const prompt = friend_moment_generation_prompt
    .replace("{{friend_name}}", ctx.friendName)
    .replace("{{profile}}", () => fillIdentity(ctx.profile))
    .replace("{{scene}}", () => fillIdentity(ctx.scene || "（平常的一天）"))
    .replace(
      "{{recent}}",
      () =>
        ctx.recent.length > 0
          ? ctx.recent.map((m) => `${fillIdentity(m.author)}（${m.mood || "未标"}）：${m.content}`).join("\n")
          : "（最近没人发什么）"
    );

  const parsed = await requestBackgroundJson(prompt, timeoutMs, `好友发帖·${ctx.friendName}`, 0.95);
  if (!parsed) return null;

  const content = String(parsed.content ?? "").trim();
  if (!content) return null;
  return { content: content.slice(0, 300), mood: normalizeMood(parsed.mood) };
}

export interface FriendCommentContext {
  friendName: string;
  profile: string;
  preferences: string;
  moment: { authorLabel: string; content: string; mood: string };
  comments: Array<{ authorLabel: string; content: string }>;
}

/** 好友在一条动态下留句话（只拿得到 feed 里的信息，看不到私聊） */
export async function generateFriendComment(
  ctx: FriendCommentContext,
  timeoutMs: number = 30000
): Promise<string | null> {
  const { friend_comment_prompt } = getPrompts();
  if (!friend_comment_prompt) return null;

  // 模板正文里的「（[user]写下的要求）」也要换成昵称：整段再过滤一遍
  const prompt = fillIdentity(
    friend_comment_prompt
      .replace("{{friend_name}}", ctx.friendName)
      .replace("{{profile}}", () => fillIdentity(ctx.profile))
      .replace("{{preferences}}", () => fillIdentity(ctx.preferences || "（没有特别要求）"))
      .replace(
        "{{moment}}",
        () => `${fillIdentity(ctx.moment.authorLabel)}（${ctx.moment.mood || "未标"}）：${ctx.moment.content}`
      )
      .replace(
        "{{comments}}",
        () =>
          ctx.comments.length > 0
            ? ctx.comments.map((c) => `${fillIdentity(c.authorLabel)}：${c.content}`).join("\n")
            : "（还没有评论）"
      )
  );

  const parsed = await requestBackgroundJson(prompt, timeoutMs, `好友评论·${ctx.friendName}`, 0.95);
  if (!parsed) return null;

  const content = String(parsed.content ?? "").trim();
  return content ? content.slice(0, 120) : null;
}

export interface FriendCommentCandidate {
  name: string;
  summary: string;
  profile: string;
}

export interface FriendCommentsContext {
  preferences: string;
  moment: { authorLabel: string; content: string; mood: string };
  comments: Array<{ authorLabel: string; content: string }>;
  /** 掷骰筛出来的「看到了这条动态的人」 */
  candidates: FriendCommentCandidate[];
}

/**
 * 一次生成「谁开口、说什么」：候选池由调用方掷骰筛出，
 * 模型自己决定谁真的会留言，也可以一个人都不回。
 */
export async function generateFriendComments(
  ctx: FriendCommentsContext,
  timeoutMs: number = 30000
): Promise<Array<{ name: string; content: string }>> {
  const { friend_comments_prompt } = getPrompts();
  if (!friend_comments_prompt || ctx.candidates.length === 0) return [];

  // 模板正文里的「（[user]写下的要求）」也要换成昵称：整段再过滤一遍
  const prompt = fillIdentity(
    friend_comments_prompt
      .replace("{{preferences}}", () => fillIdentity(ctx.preferences || "（没有特别要求）"))
      .replace(
        "{{moment}}",
        () => `${fillIdentity(ctx.moment.authorLabel)}（${ctx.moment.mood || "未标"}）：${ctx.moment.content}`
      )
      .replace("{{comments}}", () =>
        ctx.comments.length > 0
          ? ctx.comments.map((c) => `${fillIdentity(c.authorLabel)}：${c.content}`).join("\n")
          : "（还没有评论）"
      )
      .replace("{{candidates}}", () =>
        ctx.candidates
          .map(
            (c) =>
              `- ${fillIdentity(c.name)}${c.summary ? `（${fillIdentity(c.summary)}）` : ""}\n  ${fillIdentity(
                c.profile.replace(/\s+/g, " ")
              ).slice(0, 320)}`
          )
          .join("\n")
      )
  );

  const parsed = await requestBackgroundJson(
    prompt,
    timeoutMs,
    `好友评论·${ctx.candidates.length} 位候选`,
    0.95
  );
  if (!parsed) return [];

  const allowed = new Map(ctx.candidates.map((c) => [c.name, c]));
  const raw = Array.isArray(parsed.comments) ? parsed.comments : [];
  const seen = new Set<string>();
  const out: Array<{ name: string; content: string }> = [];
  for (const item of raw) {
    const name = String(item?.name ?? "").trim();
    const content = String(item?.content ?? "").trim();
    if (!content || !allowed.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, content: content.slice(0, 120) });
  }
  return out;
}

/**
 * 后台 JSON 调用的公共壳：模型路由、超时、日志、失败静默
 * （好友/实况这类内容短、频率低，失败就当这次没发生）
 */
async function requestBackgroundJson(
  prompt: string,
  timeoutMs: number,
  tag: string,
  temperature: number
): Promise<Record<string, unknown> | null> {
  const config = getModelRouting().background_extraction_config;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  logDebug(`${tag}请求`, `模型: ${config.model}\n\n=== 完整请求 ===\n${prompt}`);

  try {
    const client = getClient();
    const response = await client.chat.completions.create(
      {
        model: config.model,
        temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system" as const, content: "你是一个生活与人物设定生成引擎，只输出 JSON。" },
          { role: "user" as const, content: prompt },
        ],
      },
      { signal: controller.signal }
    );
    clearTimeout(timer);

    const text = response.choices[0]?.message?.content;
    logDebug(`${tag}返回`, `=== 完整响应 ===\n${text ?? "（空回复）"}`);
    if (!text) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err: unknown) {
    clearTimeout(timer);
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug(`${tag}失败`, err instanceof Error && err.name === "AbortError" ? `${timeoutMs}ms 超时` : errMsg);
    return null;
  }
}

/** 评论生成上下文 */
export interface MomentCommentContext {
  /** 被评论的动态 */
  moment: { author: MomentAuthor; content: string; mood: string; authorLabel?: string };
  /** 该动态下已有评论（时间升序） */
  comments: Array<{ author: MomentAuthor; content: string; authorLabel?: string }>;
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
    ? `回复${fillIdentity("[user]")}的这条评论：「${ctx.replyTo}」`
    : "给这条动态留一条你的评论";

  const prompt = (moment_comment_prompt || "")
    .replace("{{persona}}", () => fillIdentity(systemPrompt))
    .replace("{{moment}}", () => formatMomentLine(ctx.moment))
    .replace("{{comments}}", () =>
      ctx.comments.length > 0
        ? ctx.comments
            .map(
              (c) =>
                `${fillIdentity(c.authorLabel ?? (c.author === "ai" ? "你" : "[user]"))}：${c.content}`
            )
            .join("\n")
        : "（还没有评论）"
    )
    .replace("{{task}}", () => fillIdentity(task));

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
