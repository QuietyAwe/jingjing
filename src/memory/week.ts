// ============================================================
// 周与时段换算（scheduler 与 dailyLife 共用的纯函数）
//
// 单独成文件是为了避免 scheduler ↔ dailyLife 互相 import 成环：
// scheduler 要用当日实况，dailyLife 要用周起点/天索引。
// ============================================================

import dayjs from "dayjs";

/** 时段定义：0=早 1=上午 2=午 3=下午 4=晚（0-6 点返回 -1，深夜特殊处理） */
export const TIME_SLOT_LABELS = ["早(6-9)", "上午(9-12)", "午(12-15)", "下午(15-18)", "晚(18-23)"];

/** 获取某天所在周的周一（YYYY-MM-DD） */
export function getWeekStart(date: dayjs.Dayjs = dayjs()): string {
  const monday = date.day() === 0 ? date.subtract(6, "day") : date.startOf("week").add(1, "day");
  return monday.format("YYYY-MM-DD");
}

/** 根据小时获取时段索引；0-6 点返回 -1 */
export function getCurrentTimeSlot(hour: number): number {
  if (hour < 6) return -1;
  if (hour < 9) return 0;
  if (hour < 12) return 1;
  if (hour < 15) return 2;
  if (hour < 18) return 3;
  return 4;
}

/** 星期索引（0=周一, 6=周日） */
export function getCurrentDayOfWeek(date: dayjs.Dayjs = dayjs()): number {
  const day = date.day();
  return day === 0 ? 6 : day - 1;
}
