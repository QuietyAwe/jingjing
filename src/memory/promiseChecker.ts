// ============================================================
// 约定提醒模块
// 检查到期的 due_time 任务，触发系统消息提醒
// ============================================================

import { getUserInfo } from "@/db/queries";
import { getPrompts } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import dayjs from "dayjs";
import type { OngoingTask } from "@/types/schema";

export interface DuePromise {
  task: OngoingTask;
  /** 渲染好的提醒内容 */
  message: string;
}

/**
 * 检查是否有到期的约定
 * 到期条件：due_time 存在且 <= 当前时间
 */
export function checkDuePromises(): DuePromise[] {
  const userInfo = getUserInfo();
  if (!userInfo) return [];

  const now = dayjs();
  const duePromises: DuePromise[] = [];

  for (const task of userInfo.life_quests.ongoing_tasks) {
    if (!task.due_time) continue;

    const dueTime = dayjs(task.due_time);
    if (dueTime.isBefore(now) || dueTime.isSame(now)) {
      const message = buildPromiseMessage(task);
      duePromises.push({ task, message });
    }
  }

  if (duePromises.length > 0) {
    logDebug("约定提醒", `发现 ${duePromises.length} 个到期约定`);
  }

  return duePromises;
}

/**
 * 构建约定提醒消息
 */
function buildPromiseMessage(task: OngoingTask): string {
  const prompts = getPrompts();
  const template = prompts.promise_injection_template;

  if (template && template.includes("{{promises}}")) {
    return template.replace(/\{\{promises\}\}/g, `- ${task.task_name}`);
  }

  // 降级：直接返回
  return `## [约定提醒]\n\n你与用户有以下约定：\n\n- ${task.task_name}\n\n请主动提醒用户这个约定，用温暖自然的方式。`;
}

/**
 * 标记约定已提醒（删除任务）
 * 返回更新后的任务列表
 */
export function markPromiseReminded(taskName: string): OngoingTask[] {
  const userInfo = getUserInfo();
  if (!userInfo) return [];

  return userInfo.life_quests.ongoing_tasks.filter(
    (t) => t.task_name !== taskName
  );
}
