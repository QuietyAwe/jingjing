// ============================================================
// 行为时间表模块
//
// 两层：
// - 周基线表 behavior_schedule = 习惯（稳定，一周生成一次）
// - 当日实况 daily_log = 今天具体怎么过的（每天生成一次，见 dailyLife.ts）
//
// getCurrentScene 优先取当日实况，实况缺失/该格留白时回退基线——
// 生成失败不影响功能，只是没那么真。
// ============================================================

import dayjs from "dayjs";
import {
  hasScheduleForWeek,
  hasPostPlanForWeek,
  getWeekSchedule,
  getCurrentActivity,
  getEndedActivities,
  insertSchedule,
  insertPostPlan,
  type ScheduleItem,
} from "@/db/queries";
import { generateSchedule } from "@/llm/background";
import { getPrompts } from "@/prompt/config";
import { applyIdentityPlaceholders } from "@/prompt/assembler";
import { logDebug } from "@/store/chatStore";
import type { PostPlanDraft } from "@/types/schema";
import { getWeekStart, getCurrentTimeSlot, getCurrentDayOfWeek } from "./week";
import { getLiveDay, getLateNight, formatPastDaysForWeekly, dayKey } from "./dailyLife";
import { restoreIdentityNames } from "./identity";

/** 周/时段换算对外仍从本模块导出（调用方不必感知拆分） */
export { getWeekStart, getCurrentTimeSlot, getCurrentDayOfWeek };

/** 生成中的调用（in-flight 护栏）：聊天页与动态引擎可能并发触发，避免重复生成落库两份 */
let generatingSchedule: Promise<void> | null = null;

/**
 * 检查并生成本周时间表（含发帖计划）
 * 幂等：本周已有则跳过；并发调用合并为同一次生成
 */
export function checkAndGenerateSchedule(): Promise<void> {
  if (generatingSchedule) return generatingSchedule;
  generatingSchedule = doCheckAndGenerateSchedule().finally(() => {
    generatingSchedule = null;
  });
  return generatingSchedule;
}

async function doCheckAndGenerateSchedule(): Promise<void> {
  const weekStart = getWeekStart();
  // 作息表与发帖计划分开判定：本周表可能是周中才生成的，LLM 也可能把计划
  // 排在了已经过去的日子上——只看作息表会让这一周一条动态都发不出来
  const needSchedule = !hasScheduleForWeek(weekStart);
  const needPlan = !hasPostPlanForWeek(weekStart);
  if (!needSchedule && !needPlan) return;

  const today = getCurrentDayOfWeek();
  const nowSlot = getCurrentTimeSlot(dayjs().hour());
  // 只补计划、且本周已经没有可发帖的时段（周日深夜）：不必请求，也不必每 60s 重试
  if (!needSchedule && !hasRemainingSlot(today, nowSlot)) return;

  logDebug(
    "时间表",
    `本周(${weekStart})${needSchedule ? "无时间表" : "有作息表但没有发帖计划"}，开始生成`
  );

  // 获取系统人设提示词
  const { system_prompt } = getPrompts();
  if (!system_prompt) {
    logDebug("时间表", "无系统人设提示词，跳过生成");
    return;
  }

  // 上周实况优先于上周计划：实况才是习惯的证据
  // （重复出现的事自然沉淀成习惯，只试过一次的事自然消退）
  const lastWeekActuals = formatPastDaysForWeekly(7);
  const lastWeekStart = dayjs(weekStart).subtract(7, "day").format("YYYY-MM-DD");
  const lastWeekSchedule = hasScheduleForWeek(lastWeekStart)
    ? getWeekSchedule(lastWeekStart)
    : [];

  try {
    const result = await generateSchedule(system_prompt, lastWeekSchedule, 30000, lastWeekActuals);
    if (result && result.schedule.length > 0) {
      if (needSchedule) insertSchedule(weekStart, result.schedule);
      if (needPlan) {
        // 发帖计划随作息表一次产出；LLM 没给（旧提示词覆盖层）或全排在过去就用兜底
        const plan = planForRestOfWeek(result.post_plan, today, nowSlot);
        insertPostPlan(weekStart, plan);
        logDebug(
          "时间表",
          `发帖计划 ${plan.length} 条${lastWeekActuals ? "（参考了上周实况）" : ""}`
        );
      }
    } else {
      logDebug("时间表", "LLM 返回空，使用默认时间表");
      if (needSchedule) insertSchedule(weekStart, getDefaultSchedule());
      if (needPlan) insertPostPlan(weekStart, getDefaultPostPlan(today, nowSlot));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug("时间表生成失败", errMsg);
    // 失败时使用默认时间表 + 默认发帖计划
    if (needSchedule) insertSchedule(weekStart, getDefaultSchedule());
    if (needPlan) insertPostPlan(weekStart, getDefaultPostPlan(today, nowSlot));
  }
}

/** 从当前时刻起，本周是否还有可发帖的时段（早间与深夜不发，可用时段 1~4） */
function hasRemainingSlot(day: number, slot: number): boolean {
  if (day < 6) return true;
  return slot < 4 || dayjs().hour() < 23;
}

/**
 * 只保留还没过去的计划：刚过去的时段排进去只会被置 skipped，
 * 周中补计划时若全落在前几天，等于这周依然一条动态都没有
 */
function planForRestOfWeek(
  plan: PostPlanDraft[],
  today: number,
  slot: number
): PostPlanDraft[] {
  const kept = plan.filter(
    (p) => p.day_of_week > today || (p.day_of_week === today && p.time_slot >= Math.max(slot, 0))
  );
  if (kept.length === 0) return getDefaultPostPlan(today, slot);

  // 周中才生成本周计划：今天也留一条，否则用户要等好几天才看到第一条动态
  if (!kept.some((p) => p.day_of_week === today)) {
    const todayPlan = getDefaultPostPlan(today, slot).slice(0, 1);
    if (todayPlan.length > 0) kept.push(todayPlan[0]);
  }
  return kept;
}

/**
 * AI 当前的情境（自己的作息，不是用户的）
 * 用途：让 AI 在深夜/午休等场景下表现出符合自身作息的状态感
 */
export interface AIScene {
  /** 当前活动的完整一句（`[ai]` 开头、提到用户写 `[user]`），如「[ai]在窗边看书」 */
  activity: string;
  /** 上一个时段（同一段"今天"里紧挨着的那格）：留白或与当前相同为 null */
  prev: { slot: number; activity: string } | null;
  /** 今天已完成的事（只作为“记得今天做过什么”的素材，不再复述成流水账） */
  done: string[];
  /** 今天整体心情（来自当日实况） */
  mood: string;
  /** 今日主线，如「赶稿的一天」 */
  highlight: string;
  /** 伪天气（当天稳定） */
  weather: string;
  /** true=来自当日实况；false=回退周基线 */
  isLive: boolean;
}

export function getCurrentScene(now: dayjs.Dayjs = dayjs()): AIScene | null {
  const weekStart = getWeekStart(now);
  const dayOfWeek = getCurrentDayOfWeek(now);
  const timeSlot = getCurrentTimeSlot(now.hour());
  const today = dayKey(now);
  const live = getLiveDay(today);

  // 深夜（0-6 点）：由当天种子决定，且会被晨间实况生成读作因果起点
  if (timeSlot === -1) {
    return {
      activity: getLateNight(today),
      prev: null,
      done: [],
      mood: live?.mood ?? "",
      highlight: live?.highlight ?? "",
      weather: live?.weather ?? "",
      isLive: false,
    };
  }

  const baseline = getCurrentActivity(dayOfWeek, timeSlot, weekStart);
  const liveActivity = live?.slots[timeSlot]?.trim();

  // 实况这一格可能故意留白（发呆、补觉），此时回退习惯基线
  const activity = liveActivity || baseline;
  if (!activity) return null;

  const done = live
    ? live.slots.slice(0, timeSlot).filter(Boolean)
    : getEndedActivities(dayOfWeek, timeSlot, weekStart);

  // 只取紧挨着的那一格：留白就真的不给，不往回找（避免时段与内容错位）
  let prev: AIScene["prev"] = null;
  if (timeSlot > 0) {
    const prevSlot = timeSlot - 1;
    const prevActivity = live
      ? live.slots[prevSlot]?.trim()
      : getCurrentActivity(dayOfWeek, prevSlot, weekStart);
    if (prevActivity && prevActivity !== activity) {
      prev = { slot: prevSlot, activity: prevActivity };
    }
  }

  return {
    activity,
    prev,
    done,
    mood: live?.mood ?? "",
    highlight: live?.highlight ?? "",
    weather: live?.weather ?? "",
    isLive: Boolean(liveActivity),
  };
}

/** 自然的时段感（不报精确时间，避免与消息时间戳重复） */
function timeOfDay(hour: number): string {
  if (hour < 6) return "深夜";
  if (hour < 9) return "清晨";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  return "晚上";
}

/** 模型偶尔会把时段写进正文：时段由代码按当前时刻给，重复了就成「晚上，晚上…」 */
const LEAD_TIME = /^(?:深夜|清晨|上午|中午|下午|晚上)\s*[，,]\s*/;

/** 正文入口：把模型写死的真名换回占位符，并去掉重复的时段前缀 */
function sceneText(activity: string): string {
  return restoreIdentityNames(activity).replace(LEAD_TIME, "").trim();
}

/** 各时段的自然说法（下标与 AIScene.prev.slot 一致） */
const SLOT_TIME_WORDS = ["清晨", "上午", "中午", "下午", "晚上"];

/** 正文：去重复时段/主语，末尾句号交给调用方；违规的「你」按用户处理 */
function sceneBody(activity: string): string {
  return sceneText(activity)
    .replace(/^(?:我|你)\s*[，,]?\s*/, "")
    .replace(/你/g, "[user]")
    .replace(/[。.]+$/, "");
}

/** 去掉开头主语（[ai]/我/你），用于和历史里已有的旁白比对 */
function stripSceneSubject(body: string): string {
  return body.replace(/^(?:\[ai\]|我|你)\s*[，,]?\s*/i, "");
}

/**
 * 把 AI 当前情境拼成一句当下处境，供发动态与生成好友取景（第二人称）。
 *
 * 这两处提示词都是对着 AI 说「你」，所以正文里的 `[ai]`（不论在开头还是句中）
 * 全部换成「你」，不带上一个时段。
 */
export function formatScene(scene: AIScene, now: dayjs.Dayjs = dayjs()): string {
  const body = sceneBody(scene.activity).replace(/\[ai\]/gi, "你");
  return applyIdentityPlaceholders(`${timeOfDay(now.hour())}，${body}`);
}

/**
 * 聊天历史里的旁白：第三人称，「上一个时段。刚刚，此刻」。
 *
 * 例：「下午，静静在常去的咖啡馆改稿。刚刚，静静在窗边看书。」
 * - 主语由 activity 自带（`[ai]`），代码不补；开头的「我/你」是写错的主语，去掉
 * - 上一格留白、与当前相同、或已经存在当前上下文里（`isPrevSeen` 命中）时不重复写
 * - 句中残留的「你」只可能指用户，按用户渲染
 */
export function formatSceneNote(
  scene: AIScene,
  now: dayjs.Dayjs = dayjs(),
  isPrevSeen?: (text: string) => boolean
): string {
  const current = sceneBody(scene.activity);
  const prev = scene.prev ? sceneBody(scene.prev.activity) : "";
  // 用于比对"上一格是不是已经在提示词里"：去掉主语，渲染成模型实际看到的说法
  const prevText = prev ? applyIdentityPlaceholders(stripSceneSubject(prev)) : "";
  const showPrev =
    prev.length > 0 &&
    prev !== current &&
    prevText.length > 0 &&
    !isPrevSeen?.(prevText);

  if (!showPrev || !scene.prev) {
    return applyIdentityPlaceholders(`${timeOfDay(now.hour())}，${current}。`);
  }
  const prevWord = SLOT_TIME_WORDS[scene.prev.slot] ?? "刚才";
  return applyIdentityPlaceholders(`${prevWord}，${prev}。刚刚，${current}。`);
}

/** 默认时间表（LLM 生成失败时的兜底） */
function getDefaultSchedule(): ScheduleItem[] {
  const defaults = [
    "睡觉",            // 早 0-6
    "[ai]起床洗漱",    // 早 6-9
    "[ai]工作/学习",   // 上午 9-12
    "[ai]午休",        // 午 12-15
    "[ai]工作/学习",   // 下午 15-18
    "[ai]休息放松",    // 晚 18-23
  ];

  const items: ScheduleItem[] = [];
  for (let day = 0; day < 7; day++) {
    for (let slot = 0; slot < 5; slot++) {
      items.push({
        day_of_week: day,
        time_slot: slot,
        activity: defaults[slot + 1], // +1 因为跳过睡觉时段
      });
    }
  }
  return items;
}

/** 兜底发帖主题（LLM 生成失败时随机取用） */
const DEFAULT_POST_THEMES = [
  "犯困碎碎念",
  "吐槽一下日常",
  "吃到好吃的了",
  "天气不错",
  "随便感慨两句",
  "今天发生的小事",
  "想摆烂的一天",
];

/** 兜底发帖计划：随机 1~3 条，只排还没过去的日子与时段（模仿真人节奏，每次生成都不同） */
function getDefaultPostPlan(fromDay = 0, fromSlot = 0): PostPlanDraft[] {
  const themes = [...DEFAULT_POST_THEMES].sort(() => Math.random() - 0.5);

  // 1=上午 2=午 3=下午 4=晚（早间与深夜不发）
  const candidates: Array<{ day: number; slot: number }> = [];
  for (let day = fromDay; day < 7; day++) {
    for (const slot of [1, 2, 3, 4]) {
      if (day === fromDay && slot < Math.max(fromSlot, 0)) continue;
      candidates.push({ day, slot });
    }
  }
  if (candidates.length === 0) return [];

  const count = 1 + Math.floor(Math.random() * Math.min(3, candidates.length));
  return candidates
    .sort(() => Math.random() - 0.5)
    .slice(0, count)
    .map((c, i) => ({
      day_of_week: c.day,
      time_slot: c.slot,
      theme_hint: themes[i % themes.length],
    }));
}
