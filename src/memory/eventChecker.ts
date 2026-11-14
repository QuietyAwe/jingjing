// ============================================================
// 事件提醒（隐形提示词注入）
//
// 未来事件不是独立的数据结构：约定、离职、考试、手术…都是 timestamp 在未来的记忆事件
// （event_status = upcoming / caring / archived）。
// 提醒是**按次数**收敛的，一共给两次（nudge_count 计数），不再靠「用户是否提起」决定：
// - 到期前 24h：注入「xx快到了」，只提一次
// - 过期后 48h 内：注入「xx已经过去了…关心一下」，把剩下的次数用完即归档
// - 用户自己提起（判定很难命中，命中就是提前收工）/ 次数满 / 关心满 48h → 归档
// 归档只改状态：事件留在记忆里继续参与检索与衰减
// ============================================================

import dayjs from "dayjs";
import {
  getUpcomingEvents,
  getUserInfo,
  updateEventStatus,
  incrementEventNudge,
  EVENT_CARE_WINDOW_HOURS,
} from "@/db/queries";
import { getPrompts } from "@/prompt/config";
import { replacePlaceholders } from "@/prompt/assembler";
import { logDebug } from "@/store/chatStore";
import { bigrams, scoreOverlap } from "@/memory/tokenize";
import type { MemoryEvent } from "@/types/schema";

/** 「即将到来」判定窗口：到期前 24h 开始注入临近提示 */
const REMIND_BEFORE_HOURS = 24;

/** 提醒总次数上限：临近一次 + 过期后关心一次，用完就归档 */
const MAX_NUDGES = 2;

/** 用户是否提起了该事件（用户消息与事件文本有实质重合） */
function isMentioned(userInput: string, eventText: string): boolean {
  const grams = bigrams(eventText.replace(/[\s\p{P}\p{S}]/gu, ""));
  if (grams.length === 0) return false;
  const score = scoreOverlap(userInput, grams);
  // 与检索「被唤起」同一口径：≥2 个不同 bigram 命中，或事件很短（≤2 个 bigram）时 ≥1
  return score >= 2 || (score >= 1 && grams.length <= 2);
}

/** 归档：只推进状态，事件本身留在记忆里继续参与检索与衰减 */
function archiveAppointment(event: MemoryEvent): void {
  updateEventStatus(event.id, "archived");
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
  const remindEvents: MemoryEvent[] = [];
  const careEvents: MemoryEvent[] = [];
  let archived = false;

  for (const event of upcoming) {
    const due = dayjs(event.timestamp);
    const overdue = now.isAfter(due);
    const nudged = event.nudge_count ?? 0;

    // 过期后用户自己提起了 → 归档（判定很难命中，命中了就少催一次）
    if (overdue && isMentioned(userInput, event.event_text)) {
      archiveAppointment(event);
      archived = true;
      continue;
    }

    if (event.event_status === "upcoming" && overdue) {
      event.event_status = "caring";
      updateEventStatus(event.id, "caring");
    }

    if (event.event_status === "caring") {
      // 次数已满，或关心窗口（从约定时刻起算）满 48h → 归档，不再催
      if (nudged >= MAX_NUDGES || now.diff(due, "hour") >= EVENT_CARE_WINDOW_HOURS) {
        archiveAppointment(event);
        archived = true;
        continue;
      }
      careEvents.push(event);
      incrementEventNudge(event.id);
    } else if (due.diff(now, "hour") <= REMIND_BEFORE_HOURS) {
      // 临近只说一次：同一件事反复催「快到了」很吵
      if (nudged >= 1) continue;
      remindEvents.push(event);
      incrementEventNudge(event.id);
    }
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
    `临近: ${remindEvents.map((e) => e.event_text).join("、") || "无"}\n关心: ${careEvents.map((e) => e.event_text).join("、") || "无"}${archived ? "\n已归档" : ""}`
  );

  return sections.join("\n");
}
