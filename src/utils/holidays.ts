// ============================================================
// 日历语义：周几 + 中国法定节假日/调休（离线静态表）
//
// 目的：让提示词能说出「今天是2026年10月7日（周三），国庆节假期」。
// 光有周几回答不了「用户是上班还是放假」——调休补班的周六是上班日、
// 普通周三可能是国庆假期，这必须显式给日子语义。
//
// 数据来源：国务院办公厅每年发布的节假日安排通知
//   2026 年：国办发明电〔2025〕7 号（2025-11-04 发布）
// 2027 年安排公布后在 buildObservances() 里补条目即可；
// 表里没有的日期自动回退周几判断（周末→「周末」，其余→「工作日」）。
// ============================================================
import dayjs from "dayjs";

/** 周几中文名（dayjs day() 索引 0=周日） */
export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

interface Observance {
  /** 节日名，如「国庆节」 */
  name: string;
  /** true=放假（法定假或调休连休），false=调休补班（周末上班） */
  rest: boolean;
}

/** 构建 日期(YYYY-MM-DD) → 节日语义 表：只记「和普通周末/工作日不一样」的日子 */
function buildObservances(): Record<string, Observance> {
  const table: Record<string, Observance> = {};
  const fill = (name: string, rest: boolean, from: string, to: string) => {
    let d = dayjs(from);
    const end = dayjs(to);
    while (!d.isAfter(end)) {
      table[d.format("YYYY-MM-DD")] = { name, rest };
      d = d.add(1, "day");
    }
  };

  // ---- 2026（国办发明电〔2025〕7 号）----
  fill("元旦", true, "2026-01-01", "2026-01-03"); // 1/4(周日)补班
  fill("元旦", false, "2026-01-04", "2026-01-04");
  fill("春节", false, "2026-02-14", "2026-02-14"); // 节前补班
  fill("春节", true, "2026-02-15", "2026-02-23"); // 9 天连休
  fill("春节", false, "2026-02-28", "2026-02-28"); // 节后补班
  fill("清明节", true, "2026-04-04", "2026-04-06");
  fill("劳动节", true, "2026-05-01", "2026-05-05"); // 5/9(周六)补班
  fill("劳动节", false, "2026-05-09", "2026-05-09");
  fill("端午节", true, "2026-06-19", "2026-06-21");
  fill("中秋节", true, "2026-09-25", "2026-09-27");
  fill("国庆节", false, "2026-09-20", "2026-09-20"); // 节前补班
  fill("国庆节", true, "2026-10-01", "2026-10-07"); // 7 天连休
  fill("国庆节", false, "2026-10-10", "2026-10-10"); // 节后补班

  return table;
}

const OBSERVANCES = buildObservances();

export interface DayContext {
  /** 周几，如「周三」 */
  weekday: string;
  /** 日子语义：「国庆节假期」/「国庆节调休上班」/「周末」/「工作日」 */
  dayLabel: string;
  /** 是否大概率在休息（法定假期/调休连休/普通周末） */
  isRest: boolean;
}

/** 某天的日历语义（默认今天） */
export function getDayContext(date: dayjs.Dayjs = dayjs()): DayContext {
  const obs = OBSERVANCES[date.format("YYYY-MM-DD")];
  const weekday = WEEKDAYS[date.day()];
  if (obs) {
    return {
      weekday,
      dayLabel: obs.rest ? `${obs.name}假期` : `${obs.name}调休上班`,
      isRest: obs.rest,
    };
  }
  const weekend = date.day() === 0 || date.day() === 6;
  return { weekday, dayLabel: weekend ? "周末" : "工作日", isRest: weekend };
}

/**
 * 记忆区底部时间行（[today] 变量）：「今天是2026年10月7日（周三），国庆节假期」
 *
 * 刻意不带 HH:mm——精确时刻由消息时间戳负责（当时删掉旧时间行就是因为
 * 日期+时刻和时间戳重复）。这里只补时间戳说不出的部分：年份、周几、
 * 以及「上班还是放假」（法定假期/调休补班）。
 */
export function formatTodayLine(now: dayjs.Dayjs = dayjs()): string {
  const ctx = getDayContext(now);
  const date = `${now.format("YYYY年M月D日")}（${ctx.weekday}）`;
  // 普通工作日不加后缀（周几本身已说明），周末/假期/调休才显式点出
  return ctx.dayLabel === "工作日" ? `今天是${date}` : `今天是${date}，${ctx.dayLabel}`;
}

/**
 * [now] 变量渲染：「2026年10月7日（周三）15:30」
 * 比旧格式多补周几；假期语义由 formatTodayLine 承担，句子内嵌时不啰嗦
 */
export function formatNow(now: dayjs.Dayjs = dayjs()): string {
  const ctx = getDayContext(now);
  return `${now.format("YYYY年M月D日")}（${ctx.weekday}）${now.format("HH:mm")}`;
}
