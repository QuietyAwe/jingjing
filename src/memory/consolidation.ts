// ============================================================
// P5-3 / P5-4: 巩固流主模块
// 双重关联写入事务 + 30s 超时 + 计数归零
// ============================================================

import { getDB } from "@/db/connection";
import {
  getUserInfo,
  mergeUserInfo,
  insertEvent,
  insertFragment,
  getTopActive,
  getMeta,
  setMeta,
  updateEventPriority,
  getDefaultEventId,
} from "@/db/queries";
import { extractConsolidation } from "@/llm/background";
import { getThresholds } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { UserInfo } from "@/types/schema";
import dayjs from "dayjs";

const LOCK_TIMEOUT_MS = 30_000; // 30s 超时

/**
 * 检查是否应触发巩固流
 * 条件：turn_counter >= 阈值 且 is_locked == false 且 user_info 存在
 */
export function shouldConsolidate(): boolean {
  const locked = getMeta("is_locked");
  const counter = parseInt(getMeta("turn_counter") ?? "0", 10);
  const { consolidation_window_turns } = getThresholds();

  logDebug("巩固检查", `turn_counter=${counter}, threshold=${consolidation_window_turns}, is_locked=${locked}`);

  if (locked === "true") return false;
  return counter >= consolidation_window_turns;
}

/**
 * 执行巩固流
 * @param recentMessages 最近的对话消息（不含 system）
 * @returns 是否成功写入
 */
export async function runConsolidation(
  recentMessages: Array<{ role: string; content: string }>,
): Promise<boolean> {
  const counterBefore = parseInt(getMeta("turn_counter") ?? "0", 10);
  logDebug("巩固开始", `turn_counter=${counterBefore}, 消息数=${recentMessages.length}`);

  // 1. 获取锁
  setMeta("is_locked", "true");

  // 30s 超时兜底
  const timeoutTimer = setTimeout(() => {
    logDebug("巩固超时", "30s 强制解锁, turn_counter=0, is_locked=false");
    setMeta("is_locked", "false");
    setMeta("turn_counter", "0");
  }, LOCK_TIMEOUT_MS);

  try {
    // 2. 读取当前 user_info
    let userInfo = getUserInfo();
    if (!userInfo) {
      // 空库首次：用空模板
      userInfo = {
        basic_identity: { nickname: "", gender: "", birthday: "", occupation: "", location: "" },
        preferences: { likes: [], dislikes: [] },
        social_graph: [],
        psycho_state: { personality_traits: [], current_stressors: [], comm_preference: "" },
        life_quests: { long_term_goals: [], ongoing_tasks: [] },
      };
    }

    // 3. 取最近 10 轮快照（20 条）
    const snapshot = recentMessages.slice(-20);

    // 4. 取已有索引事件（供 LLM 判断挂靠）
    const existingEvents = getTopActive(50);

    // 5. 调用后台 LLM 提取
    const result = await extractConsolidation(userInfo, snapshot, existingEvents, LOCK_TIMEOUT_MS - 2000);
    if (!result) {
      logDebug("巩固结果", "LLM 提取失败或返回空, turn_counter=0, is_locked=false");
      clearTimeout(timeoutTimer);
      setMeta("is_locked", "false");
      setMeta("turn_counter", "0");
      return false;
    }

    // 6. 双重关联写入（SQLite 事务）
    const db = getDB();
    await db.withExclusiveTransactionAsync(async () => {
      // 6a. Merge user_info
      mergeUserInfo(result.updated_user_info);

      // 同步昵称到设置 store
      const newNickname = result.updated_user_info.basic_identity?.nickname;
      if (newNickname) {
        useSettingsStore.getState().saveUserNickname(newNickname);
      }

      // 6b. 确定挂靠事件
      let targetEventId: number;
      const frag = result.new_fragment;
      const priority = frag.priority || 5;

      if (frag.target_event_index > 0) {
        // LLM 指定了已有事件 ID
        targetEventId = frag.target_event_index;
      } else if (frag.new_event_text?.trim()) {
        // LLM 认为需要新建事件
        targetEventId = insertEvent(frag.new_event_text.trim(), 100, 0, priority);
      } else {
        // 兜底：挂靠默认事件"日常闲聊"
        const defaultId = getDefaultEventId();
        if (defaultId) {
          targetEventId = defaultId;
        } else {
          // 默认事件不存在时，创建占位事件
          targetEventId = insertEvent("日常闲聊", 50, 0, 1);
        }
      }

      // 6c. 写入记忆片段
      insertFragment(
        targetEventId,
        frag.summary,
        frag.emotion,
        priority,
      );

      // 6d. 更新事件优先级（max 操作）
      updateEventPriority(targetEventId, priority);
    });

    clearTimeout(timeoutTimer);

    // 6. 释放锁 + 清零计数
    setMeta("is_locked", "false");
    setMeta("turn_counter", "0");

    logDebug("巩固完成", `摘要: ${result.new_fragment.summary}\n情绪: ${result.new_fragment.emotion}\nturn_counter=0, is_locked=false`);
    return true;
  } catch (err) {
    clearTimeout(timeoutTimer);
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug("巩固异常", `${errMsg}\nturn_counter=0, is_locked=false`);
    setMeta("is_locked", "false");
    setMeta("turn_counter", "0");
    return false;
  }
}
