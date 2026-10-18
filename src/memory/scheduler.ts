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
  getWeekSchedule,
  getCurrentActivity,
  getEndedActivities,
  insertSchedule,
  insertPostPlan,
  type ScheduleItem,
} from "@/db/queries";
import { generateSchedule } from "@/llm/background";
import { getPrompts } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import type { PostPlanDraft } from "@/types/schema";
import { getWeekStart, getCurrentTimeSlot, getCurrentDayOfWeek } from "./week";
import { getLiveDay, getLateNight, formatPastDaysForWeekly, dayKey } from "./dailyLife";

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

  if (hasScheduleForWeek(weekStart)) {
    // 静默跳过：动态引擎每 60s 轮询一次都会走到这里，打日志会无限刷屏；
    // 只有真正触发生成/失败才记日志
    return;
  }

  logDebug("时间表", `本周(${weekStart})无时间表，开始生成`);

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
      insertSchedule(weekStart, result.schedule);
      // 发帖计划随作息表一并落库；LLM 没给（旧提示词覆盖层）就用兜底计划
      const plan = result.post_plan.length > 0 ? result.post_plan : getDefaultPostPlan();
      insertPostPlan(weekStart, plan);
      logDebug(
        "时间表",
        `生成完成，作息 ${result.schedule.length} 条，发帖计划 ${plan.length} 条${lastWeekActuals ? "（参考了上周实况）" : ""}`
      );
    } else {
      logDebug("时间表", "LLM 返回空，使用默认时间表");
      insertSchedule(weekStart, getDefaultSchedule());
      insertPostPlan(weekStart, getDefaultPostPlan());
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug("时间表生成失败", errMsg);
    // 失败时使用默认时间表 + 默认发帖计划
    insertSchedule(weekStart, getDefaultSchedule());
    insertPostPlan(weekStart, getDefaultPostPlan());
  }
}

/**
 * AI 当前的情境（自己的作息，不是用户的）
 * 用途：让 AI 在深夜/午休等场景下表现出符合自身作息的状态感
 */
export interface AIScene {
  /** 当前活动短语，例如「在窗边看书」「凌晨才睡着，还困着」 */
  activity: string;
  /** 今天已完成的事（只作为“记得今天做过什么”的素材，不再复述成流水账） */
  done: string[];
  /** 今天整体心情（来自当日实况） */
  mood: string;
  /** 今日主线，如「面试的一天」 */
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

  return {
    activity,
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

/**
 * 把 AI 当前情境拼成一句当下处境，注入状态区。
 *
 * 刻意只给一句：真人不复述自己一天的流水账（「今天已经晨跑、看书」），
 * done 列表留作 remark 素材——AI 需要时能提，但不主动报备。
 */
export function formatScene(scene: AIScene, now: dayjs.Dayjs = dayjs()): string {
  return `${timeOfDay(now.hour())}，你${scene.activity}`;
}

/** 默认时间表（LLM 生成失败时的兜底） */
function getDefaultSchedule(): ScheduleItem[] {
  const defaults = [
    "睡觉",        // 早 0-6
    "起床洗漱",    // 早 6-9
    "工作/学习",   // 上午 9-12
    "午休",        // 午 12-15
    "工作/学习",   // 下午 15-18
    "休息放松",    // 晚 18-23
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

/** 兜底发帖计划：随机 2~4 天、随机白天/晚间时段，每次生成都不同（模仿真人节奏） */
function getDefaultPostPlan(): PostPlanDraft[] {
  const days = [0, 1, 2, 3, 4, 5, 6].sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 3));
  const themes = [...DEFAULT_POST_THEMES].sort(() => Math.random() - 0.5);
  return days.map((day, i) => ({
    day_of_week: day,
    // 1=上午 2=午 3=下午 4=晚（早间与深夜不发）
    time_slot: 1 + Math.floor(Math.random() * 4),
    theme_hint: themes[i % themes.length],
  }));
}
