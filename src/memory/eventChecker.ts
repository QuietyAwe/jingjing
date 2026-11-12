// ============================================================
// 事件提醒（隐形提示词注入）
//
// 未来事件不是独立的数据结构：约定、离职、考试、手术…都是 timestamp 在未来的记忆事件
// （event_status = upcoming / caring / archived）。
// - 到期前 24h：注入「xx快到了」，AI 在下一次回复里自然提起
// - 过期且用户没提起：注入「xx已经过去了…找个契机关心一下」，持续注入
// - 用户提起 或 关心满 48h：归档（事件留在记忆里可被检索，同时转成一条状态）
// ============================================================

import dayjs from "dayjs";
import {
  getUpcomingEvents,
  getUserInfo,
  setUserInfo,
  updateEventStatus,
  EVENT_CARE_WINDOW_HOURS,
} from "@/db/queries";
import { getPrompts } from "@/prompt/config";
import { replacePlaceholders } from "@/prompt/assembler";
import { logDebug } from "@/store/chatStore";
import { bigrams, scoreOverlap } from "@/memory/tokenize";
import type { MemoryEvent, StateItem } from "@/types/schema";

/** 「即将到来」判定窗口：到期前 24h 开始注入临近提示 */
const REMIND_BEFORE_HOURS = 24;

/** 用户是否提起了该事件（用户消息与事件文本有实质重合） */
function isMentioned(userInput: string, eventText: string): boolean {
  const grams = bigrams(eventText.replace(/[\s\p{P}\p{S}]/gu, ""));
  if (grams.length === 0) return false;
  const score = scoreOverlap(userInput, grams);
  // 与检索「被唤起」同一口径：≥2 个不同 bigram 命中，或事件很短（≤2 个 bigram）时 ≥1
  return score >= 2 || (score >= 1 && grams.length <= 2);
}

/** 归档：事件转成一条状态（「[time]面试刚过去」），事件本身留在记忆里 */
function archiveAppointment(event: MemoryEvent, states: StateItem[], now: dayjs.Dayjs): void {
  updateEventStatus(event.id, "archived");
  states.push({ text: `[time]${event.event_text}刚过去`, created_at: now.toISOString() });
}

/**
 * 推进约定生命周期，生成本轮的隐形提示词
 *
 * @param userInput 本轮用户输入（用于判定「用户提起」）
 * @returns 隐形提示词文本（无相关约定返回 null），由调用方拼进消息末尾
 */
export function buildEventNudges(userInput: string): string | null {
  const upcoming = getUpcomingEvents();
  if (upcoming.length === 0) return null;

  const userInfo = getUserInfo();
  const now = dayjs();
  const states = userInfo ? [...userInfo.states] : [];
  const remindEvents: MemoryEvent[] = [];
  const careEvents: MemoryEvent[] = [];
  let changed = false;

  for (const event of upcoming) {
    const due = dayjs(event.timestamp);
    const overdue = now.isAfter(due);

    // 过期后用户提起过 → 归档（关心已经给到）
    if (overdue && isMentioned(userInput, event.event_text)) {
      archiveAppointment(event, states, now);
      changed = true;
      continue;
    }

    if (event.event_status === "upcoming" && overdue) {
      event.event_status = "caring";
      updateEventStatus(event.id, "caring");
      changed = true;
    }

    if (event.event_status === "caring") {
      // 关心窗口从约定时刻起算，满 48h 自动归档，不再催
      if (now.diff(due, "hour") >= EVENT_CARE_WINDOW_HOURS) {
        archiveAppointment(event, states, now);
        changed = true;
        continue;
      }
      careEvents.push(event);
    } else if (due.diff(now, "hour") <= REMIND_BEFORE_HOURS) {
      remindEvents.push(event);
    }
  }

  if (changed && userInfo) {
    setUserInfo({ ...userInfo, states });
  }
  if (remindEvents.length === 0 && careEvents.length === 0) return null;

  const prompts = getPrompts();
  const sections: string[] = [];

  const render = (tpl: string, event: MemoryEvent): string =>
    replacePlaceholders(
      tpl
        .replace(/\{\{event\}\}/g, event.event_text)
        .replace(/\{\{due_time\}\}/g, dayjs(event.timestamp).format("M/D HH:mm")),
      event.timestamp,
      userInfo,
      now
    );

  if (remindEvents.length > 0) {
    const tpl =
      prompts.event_reminder_template ||
      "## [事件临近]\n[user] 的「{{event}}」快到时间了（{{due_time}}），在接下来的回复里找个合适的机会自然地提一下，别太刻意。";
    for (const event of remindEvents) sections.push(render(tpl, event));
  }
  if (careEvents.length > 0) {
    const tpl =
      prompts.event_care_template ||
      "## [事件关心]\n[user] 的「{{event}}」已经过去了（原定 {{due_time}}），[user] 还没提起过。在接下来的回复中，找个合适的契机关心一下吧。";
    for (const event of careEvents) sections.push(render(tpl, event));
  }

  logDebug(
    "事件提醒",
    `临近: ${remindEvents.map((e) => e.event_text).join("、") || "无"}\n关心: ${careEvents.map((e) => e.event_text).join("、") || "无"}${changed ? "\n已归档/转状态" : ""}`
  );

  return sections.join("\n");
}
