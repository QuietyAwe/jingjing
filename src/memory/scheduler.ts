// ============================================================
// 行为时间表模块
// 生成每周行为时间表，查询当前状态用于 Prompt 注入
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

/** 时段定义 */
const TIME_SLOTS = [
  { index: 0, label: "早", range: "6-9点" },
  { index: 1, label: "上午", range: "9-12点" },
  { index: 2, label: "午", range: "12-15点" },
  { index: 3, label: "下午", range: "15-18点" },
  { index: 4, label: "晚", range: "18-23点" },
];

/** 获取本周一的日期字符串 */
export function getWeekStart(date: dayjs.Dayjs = dayjs()): string {
  const monday = date.day() === 0 ? date.subtract(6, "day") : date.startOf("week").add(1, "day");
  return monday.format("YYYY-MM-DD");
}

/** 根据当前时间获取时段索引 */
export function getCurrentTimeSlot(hour: number): number {
  if (hour < 6) return -1;  // 深夜/凌晨，特殊处理
  if (hour < 9) return 0;   // 早(6-9点)
  if (hour < 12) return 1;  // 上午(9-12点)
  if (hour < 15) return 2;  // 午(12-15点)
  if (hour < 18) return 3;  // 下午(15-18点)
  return 4;                 // 晚(18-23点)
}

/**
 * 深夜活动（0-6点）
 * 以「你」叙述 AI 自身状态（状态区为 system 内容，其中的「你」指 AI），
 * 指代用户时用 [user] 变量，由状态区渲染替换为昵称，避免人称混淆
 */
const LATE_NIGHT_ACTIVITIES = [
  "准备睡觉了",
  "已经睡着了，被[user]叫醒了",
  "还在迷糊中",
  "做了个奇怪的梦",
  "失眠中，正好[user]来了",
];

/** 根据当前时间获取星期几（0=周一, 6=周日） */
export function getCurrentDayOfWeek(): number {
  const day = dayjs().day();
  return day === 0 ? 6 : day - 1;
}

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

  // 获取上周时间表作为参考
  const lastWeekStart = dayjs(weekStart).subtract(7, "day").format("YYYY-MM-DD");
  const lastWeekSchedule = hasScheduleForWeek(lastWeekStart)
    ? getWeekSchedule(lastWeekStart)
    : [];

  try {
    const result = await generateSchedule(system_prompt, lastWeekSchedule);
    if (result && result.schedule.length > 0) {
      insertSchedule(weekStart, result.schedule);
      // 发帖计划随作息表一并落库；LLM 没给（旧提示词覆盖层）就用兜底计划
      const plan = result.post_plan.length > 0 ? result.post_plan : getDefaultPostPlan();
      insertPostPlan(weekStart, plan);
      logDebug("时间表", `生成完成，作息 ${result.schedule.length} 条，发帖计划 ${plan.length} 条`);
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
  /** 当前活动短语，例如「在窗边看书」「准备睡觉了」 */
  activity: string;
  /** 今天已完成的活动，例如 ['晨跑','看书'] */
  done: string[];
}

// 缓存深夜状态，避免每次调用都随机变化
let cachedLateNightActivity: string | null = null;
let cachedLateNightHour: number = -1;

export function getCurrentScene(): AIScene | null {
  const weekStart = getWeekStart();
  const now = dayjs();
  const dayOfWeek = getCurrentDayOfWeek();
  const timeSlot = getCurrentTimeSlot(now.hour());

  // 深夜时段（0-6点）使用缓存，同一小时内保持一致
  if (timeSlot === -1) {
    const currentHour = now.hour();
    if (cachedLateNightHour !== currentHour || !cachedLateNightActivity) {
      cachedLateNightActivity = LATE_NIGHT_ACTIVITIES[Math.floor(Math.random() * LATE_NIGHT_ACTIVITIES.length)];
      cachedLateNightHour = currentHour;
    }
    return { activity: cachedLateNightActivity, done: [] };
  }

  // 非深夜时段清除缓存
  cachedLateNightActivity = null;
  cachedLateNightHour = -1;

  const currentActivity = getCurrentActivity(dayOfWeek, timeSlot, weekStart);
  if (!currentActivity) return null;

  return {
    activity: currentActivity,
    done: getEndedActivities(dayOfWeek, timeSlot, weekStart),
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
 * 把 AI 当前情境拼成一句自然的话，注入到 Prompt 的 [你] 段落
 * 例如「下午，你刚看完书；今天已经晨跑、看书」
 *
 * 刻意不报精确时间——精确时间由消息时间戳持续提供，
 * 这里只给「深夜/下午」这样的时段感，用来配合作息判断。
 */
export function formatScene(scene: AIScene, now: dayjs.Dayjs = dayjs()): string {
  const done = scene.done.length > 0 ? `；今天已经${scene.done.join("、")}` : "";
  return `${timeOfDay(now.hour())}，你${scene.activity}${done}`;
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
