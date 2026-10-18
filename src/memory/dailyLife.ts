// ============================================================
// 每日实况（daily_log）
//
// 周基线表只负责「习惯」：她一直是那样的人。
// 这张表负责「今天具体怎么过的」：昨夜没睡好、今天下雨、面试、临时放空。
// 实况由基线 + 昨夜 + 节假日 + 伪天气 + 用户在场 生成，一天一次，失败回退基线。
//
// 依赖方向：本模块只被 scheduler / 动态引擎 / 聊天页使用，
// 不要被 chatStore 或 prompt/assembler 反向依赖（会成环）。
// ============================================================

import dayjs from "dayjs";
import { getDailyLog, upsertDailyLog, getRecentDailyLogs, getUserInfo, activeStates, activeEvents, getWeekSchedule, getMoments } from "@/db/queries";
import { generateDailyLife } from "@/llm/background";
import { hasApiKey } from "@/llm/client";
import { getPrompts } from "@/prompt/config";
import { getDayContext } from "@/utils/holidays";
import {
  getWeekStart,
  getCurrentDayOfWeek,
  getCurrentTimeSlot,
  TIME_SLOT_LABELS,
} from "@/memory/week";
import { useChatStore, logDebug } from "@/store/chatStore";
import type { DailyLog } from "@/types/schema";

/** 时段标签（与 scheduler 的时段编码一致） */
const DAILY_SLOT_LABELS = TIME_SLOT_LABELS;

/** 失败后多久再试（避免每次轮询都打一次失败请求） */
const RETRY_AFTER_MS = 30 * 60 * 1000;

// --- 伪天气：按日期做种子，当天稳定、跨日变化（不接真实天气 API） ---
const WEATHER_POOL = ["晴", "多云", "阴", "小雨", "阵雨", "晴转多云", "风有点大", "降温了"];

/** FNV-1a：同一字符串稳定得到同一个数，用于「同一天/同一个人」的确定性掷骰 */
export function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function pseudoWeather(day: string): string {
  return WEATHER_POOL[stableHash(`${day}#weather`) % WEATHER_POOL.length];
}

// --- 深夜状态（0-6 点）：由日期种子决定，同一天凌晨保持一致 ---
const LATE_NIGHT_STATES = [
  "还醒着，窝在被子里刷手机",
  "刚迷迷糊糊睡着，又被消息震醒",
  "失眠，翻来覆去好久了",
  "做了个乱七八糟的梦，刚醒",
  "熬到现在，眼皮已经睁不开",
  "醒了，脑子还在转白天的事",
];

export function lateNightStateFor(day: string): string {
  return LATE_NIGHT_STATES[stableHash(`${day}#late`) % LATE_NIGHT_STATES.length];
}

/** 当天日期键（本地时区） */
export function dayKey(date: dayjs.Dayjs = dayjs()): string {
  return date.format("YYYY-MM-DD");
}

/** 解析后的当日实况 */
export interface LiveDay {
  day: string;
  /** 5 格，空串表示该时段留白 */
  slots: string[];
  mood: string;
  highlight: string;
  weather: string;
  /** 当天凌晨（0-6 点）的状态 */
  lateNight: string;
}

function parseSlots(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((s) => (typeof s === "string" ? s.trim() : "")).slice(0, 5);
  } catch {
    return [];
  }
}

/** 读取某天已落库的实况；只有深夜状态、没有白天内容时返回 null（白天仍走基线） */
export function getLiveDay(day: string = dayKey()): LiveDay | null {
  const row = getDailyLog(day);
  if (!row) return null;
  const slots = parseSlots(row.slots);
  const hasDayContent = slots.some((s) => s.length > 0);
  if (!hasDayContent && !row.highlight) return null;
  return {
    day: row.day,
    slots,
    mood: row.mood,
    highlight: row.highlight,
    weather: row.weather,
    lateNight: row.late_night,
  };
}

/** 当天凌晨的状态（没生成过就用种子值，保证同一天稳定） */
export function getLateNight(day: string = dayKey()): string {
  const row = getDailyLog(day);
  return row?.late_night?.trim() || lateNightStateFor(day);
}

// --- 生成 ---

let generating: Promise<void> | null = null;
let lastAttemptDay = "";
let lastAttemptAt = 0;

/**
 * 确保今天的实况已经生成（幂等 + in-flight 护栏 + 失败退避）
 *
 * 触发点：聊天页启动、动态引擎 60s 轮询。
 * 失败不写库：getCurrentScene 会回退到周基线表，功能不降级，只是没那么真。
 */
export function ensureDailyLife(): Promise<void> {
  if (generating) return generating;
  generating = doEnsureDailyLife().finally(() => {
    generating = null;
  });
  return generating;
}

async function doEnsureDailyLife(): Promise<void> {
  const now = dayjs();
  const day = dayKey(now);

  const existing = getDailyLog(day);
  if (existing && parseSlots(existing.slots).some((s) => s.length > 0)) return;

  // 0-6 点不生成：深夜只有「凌晨状态」，白天怎么过得等天亮再定；
  // 清晨生成时会读到同一个（按日期种子的）凌晨状态，因果链不断
  if (getCurrentTimeSlot(now.hour()) === -1) return;

  if (!hasApiKey()) return;

  if (lastAttemptDay === day && Date.now() - lastAttemptAt < RETRY_AFTER_MS) return;
  lastAttemptDay = day;
  lastAttemptAt = Date.now();

  const { system_prompt } = getPrompts();
  if (!system_prompt.trim()) return;

  const result = await generateDailyLife(system_prompt, buildDailyLifeInput(now));
  if (!result) {
    logDebug("每日实况", `${day} 生成失败，今天回退周基线表`);
    return;
  }

  upsertDailyLog(day, {
    slots: JSON.stringify(result.slots),
    mood: result.mood,
    highlight: result.highlight,
    weather: pseudoWeather(day),
    late_night: getLateNight(day),
  });
  logDebug(
    "每日实况",
    `${day} 已生成：${result.highlight || "（无主线）"}\n${result.slots
      .map((s, i) => (s ? `${DAILY_SLOT_LABELS[i]}=${s}` : ""))
      .filter(Boolean)
      .join("\n")}`
  );
}

/** 组装日生成输入 */
function buildDailyLifeInput(now: dayjs.Dayjs): Parameters<typeof generateDailyLife>[1] {
  const day = dayKey(now);
  const ctx = getDayContext(now);

  // 基线 5 格（本周表还没生成时留空，让 LLM 自由发挥）
  const weekStart = getWeekStart(now);
  const baselineItems = getWeekSchedule(weekStart).filter(
    (s) => s.day_of_week === getCurrentDayOfWeek()
  );
  const baseline =
    baselineItems.length > 0
      ? baselineItems
          .slice()
          .sort((a, b) => a.time_slot - b.time_slot)
          .map((s) => `${DAILY_SLOT_LABELS[s.time_slot]}：${s.activity}`)
          .join("\n")
      : "（这周还没排习惯，按你平时的样子来）";

  return {
    date: `${now.format("M月D日")}（${ctx.weekday}）`,
    dayContext: ctx.dayLabel,
    weather: pseudoWeather(day),
    baseline,
    yesterday: formatLogForPrompt(getDailyLog(dayjs(day).subtract(1, "day").format("YYYY-MM-DD"))),
    lateNight: getLateNight(day),
    userContext: buildUserContext(now),
  };
}

/** 把一天的实况压成 prompt 里的一段 */
function formatLogForPrompt(row: DailyLog | null): string {
  if (!row) return "（昨天没有记录，按平常的日子来）";
  const slots = parseSlots(row.slots);
  const lines: string[] = [];
  if (row.highlight) lines.push(`主线：${row.highlight}`);
  if (row.mood) lines.push(`心情：${row.mood}`);
  slots.forEach((s, i) => {
    if (s) lines.push(`${DAILY_SLOT_LABELS[i]}：${s}`);
  });
  if (row.late_night) lines.push(`凌晨：${row.late_night}`);
  return lines.length > 0 ? lines.join("\n") : "（昨天没有记录，按平常的日子来）";
}

/**
 * 用户在场感：今天和[user]有关的事（约定/近况/昨晚聊很晚/昨天发的心情）。
 * 这是「AI 的生活里有用户」的入口——不是让 AI 报备，是让今天的行为被用户影响。
 */
function buildUserContext(now: dayjs.Dayjs): string {
  const lines: string[] = [];
  const info = getUserInfo();

  if (info) {
    // 今天的约定：今天有面试/复查，实况里就该出现
    for (const e of activeEvents(info)) {
      const due = dayjs(e.due_time);
      if (!due.isValid()) continue;
      if (due.isSame(now, "day")) {
        lines.push(`今天 [user] 有「${e.text}」（${due.format("HH:mm")}）`);
      }
    }
    for (const s of activeStates(info, now).slice(-2)) {
      lines.push(`[user] 近况：${s.text}`);
    }
  }

  // 昨晚聊到很晚 → 今早有代价（只读消息时间戳，不写任何东西）
  const messages = useChatStore.getState().messages;
  const lateWindowStart = now.subtract(1, "day").hour(21).minute(0);
  const lateWindowEnd = now.hour(4).minute(0);
  let latestLateChat: dayjs.Dayjs | null = null;
  // 只扫最近 50 条；深夜窗口内取最晚的那条（不因今天白天发过消息而被覆盖）
  for (const m of messages.slice(-50)) {
    if (m.game_id || m.friend_id) continue;
    const ts = dayjs(m.timestamp);
    if (!ts.isValid()) continue;
    if (ts.isAfter(lateWindowStart) && ts.isBefore(lateWindowEnd)) {
      if (!latestLateChat || ts.isAfter(latestLateChat)) latestLateChat = ts;
    }
  }
  if (latestLateChat) {
    lines.push(`[user] 昨晚和你聊到 ${latestLateChat.format("HH:mm")}`);
  }

  // 昨天发过心情动态 → 今天的心情可能还受影响
  const since = now.subtract(1, "day");
  const userMoment = getMoments(10).find(
    (m) => m.author === "user" && dayjs(m.created_at).isAfter(since)
  );
  if (userMoment) {
    lines.push(`[user] 昨天发了条心情动态：「${userMoment.content.slice(0, 40)}」`);
  }

  return lines.length > 0 ? lines.join("\n") : "（今天没有特别和[user]有关的事）";
}

/**
 * 近 N 天的实况文本，作为周表生成的 {{last_week}}：
 * 让 LLM 从「实际发生过什么」里自己完成习惯化——重复出现的事沉淀成习惯，
 * 只试过一次的事自然消退，不需要额外权重逻辑。
 */
export function formatPastDaysForWeekly(days: number = 7): string {
  const today = dayKey();
  const rows = getRecentDailyLogs(days, today);
  if (rows.length === 0) return "";

  const lines: string[] = [];
  for (const row of rows) {
    const d = dayjs(row.day);
    const slots = parseSlots(row.slots);
    const parts = slots
      .map((s, i) => (s ? `${DAILY_SLOT_LABELS[i].replace(/\(.*\)/, "")}=${s}` : ""))
      .filter(Boolean);
    const head = `${d.format("M/D")}（${getDayContext(d).weekday}）`;
    lines.push(`${head}：${parts.join("；") || "（几乎没做什么）"}`);
    if (row.highlight) lines.push(`  主线：${row.highlight}`);
  }
  return lines.join("\n");
}
