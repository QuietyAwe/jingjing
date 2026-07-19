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
  getUserInfo,
  type ScheduleItem,
} from "@/db/queries";
import { generateSchedule } from "@/llm/background";
import { logDebug } from "@/store/chatStore";

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
  if (hour < 9) return 0;
  if (hour < 12) return 1;
  if (hour < 15) return 2;
  if (hour < 18) return 3;
  return 4;
}

/** 根据当前时间获取星期几（0=周一, 6=周日） */
export function getCurrentDayOfWeek(): number {
  const day = dayjs().day();
  return day === 0 ? 6 : day - 1;
}

/**
 * 检查并生成本周时间表
 * 首次对话时调用，如本周无时间表则生成
 */
export async function checkAndGenerateSchedule(): Promise<void> {
  const weekStart = getWeekStart();

  if (hasScheduleForWeek(weekStart)) {
    logDebug("时间表", `本周(${weekStart})已有时间表，跳过生成`);
    return;
  }

  logDebug("时间表", `本周(${weekStart})无时间表，开始生成`);

  const userInfo = getUserInfo();
  if (!userInfo) {
    logDebug("时间表", "无用户信息，跳过生成");
    return;
  }

  // 获取上周时间表作为参考
  const lastWeekStart = dayjs(weekStart).subtract(7, "day").format("YYYY-MM-DD");
  const lastWeekSchedule = hasScheduleForWeek(lastWeekStart)
    ? getWeekSchedule(lastWeekStart)
    : [];

  try {
    const schedule = await generateSchedule(userInfo, lastWeekSchedule);
    if (schedule && schedule.length > 0) {
      insertSchedule(weekStart, schedule);
      logDebug("时间表", `生成完成，共 ${schedule.length} 条`);
    } else {
      logDebug("时间表", "LLM 返回空，使用默认时间表");
      insertSchedule(weekStart, getDefaultSchedule());
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug("时间表生成失败", errMsg);
    // 失败时使用默认时间表
    insertSchedule(weekStart, getDefaultSchedule());
  }
}

/**
 * 获取当前状态描述
 * 用于注入到 Prompt 的状态区
 */
export function getCurrentStatus(): string | null {
  const weekStart = getWeekStart();
  const now = dayjs();
  const dayOfWeek = getCurrentDayOfWeek();
  const timeSlot = getCurrentTimeSlot(now.hour());

  const currentActivity = getCurrentActivity(dayOfWeek, timeSlot, weekStart);
  if (!currentActivity) return null;

  const endedActivities = getEndedActivities(dayOfWeek, timeSlot, weekStart);

  const parts: string[] = [];
  parts.push(`当前：${currentActivity}`);

  if (endedActivities.length > 0) {
    parts.push(`今天已完成：${endedActivities.join("、")}`);
  }

  return parts.join("\n");
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
