// ============================================================
// P6: 前台闲置做梦流
// P6-1: AppState + 180s 闲置检测
// P6-2: 冷数据 LLM 折叠
// P6-3: 事务提交 + 软归档
// ============================================================

import { AppState, type AppStateStatus } from "react-native";
import { getDB } from "@/db/connection";
import {
  getActiveCount,
  getColdestEvents,
  insertEvent,
  softArchiveBatch,
} from "@/db/queries";
import { getClient, hasApiKey } from "@/llm/client";
import { getPrompts, getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";

const IDLE_TIMEOUT_MS = 180_000; // 180s
const COLDEST_LIMIT = 10;
const MIN_ACTIVE_EVENTS = 50;

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let appStateSubscription: { remove: () => void } | null = null;
let isDreaming = false;
let onDreamComplete: (() => void) | null = null;

/** 启动做梦流监听（App 根组件挂载时调用） */
export function startDreaming(): void {
  // 清理旧监听
  stopDreaming();

  const onChange = (state: AppStateStatus) => {
    if (state === "active") {
      resetIdleTimer();
    } else {
      clearIdleTimer();
    }
  };

  appStateSubscription = AppState.addEventListener("change", onChange);

  // 初始状态：如果 App 已在前台，开始计时
  if (AppState.currentState === "active") {
    resetIdleTimer();
  }
}

/** 停止监听（App 卸载时调用） */
export function stopDreaming(): void {
  clearIdleTimer();
  appStateSubscription?.remove();
  appStateSubscription = null;
}

/** 用户有操作时重置计时器（在聊天/输入时调用） */
export function resetIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    tryDream();
  }, IDLE_TIMEOUT_MS);
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** 注册做梦完成回调 */
export function onDreamDone(callback: () => void): void {
  onDreamComplete = callback;
}

/** 尝试执行做梦流 */
async function tryDream(): Promise<void> {
  // 前置条件检查
  if (isDreaming) return;
  if (!hasApiKey()) return;

  const activeCount = getActiveCount();
  if (activeCount <= MIN_ACTIVE_EVENTS) {
    return;
  }

  isDreaming = true;
  logDebug("做梦", `触发，活跃事件: ${activeCount}`);

  try {
    // P6-2: 取 10 条最冷事件
    const coldest = getColdestEvents(COLDEST_LIMIT);
    if (coldest.length === 0) {
      isDreaming = false;
      return;
    }

    // 调用 LLM 折叠
    const folded = await foldEvents(coldest.map((e) => e.event_text));
    if (!folded || folded.length === 0) {
      logDebug("做梦", "LLM 折叠返回空");
      isDreaming = false;
      return;
    }

    // P6-3: 事务提交 + 软归档
    // 取原事件的最高优先级，保留到折叠后的新事件
    const maxPriority = Math.max(...coldest.map((e) => e.priority || 5));

    const db = getDB();
    await db.withExclusiveTransactionAsync(async () => {
      // 插入折叠后的新事件（保留原事件最高优先级）
      for (const text of folded) {
        insertEvent(text, 100, 0, maxPriority);
      }

      // 软归档原事件
      softArchiveBatch(coldest.map((e) => e.id));
    });

    logDebug("做梦完成", `折叠 ${coldest.length} → ${folded.length} 条`);
    onDreamComplete?.();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug("做梦异常", errMsg);
  } finally {
    isDreaming = false;
    // 重新开始计时
    if (AppState.currentState === "active") {
      resetIdleTimer();
    }
  }
}

/**
 * 调用 LLM 将多条琐碎事件语义折叠为 1-2 条概括事件
 */
async function foldEvents(eventTexts: string[]): Promise<string[] | null> {
  const { dream_consolidation_prompt } = getPrompts();
  const routing = getModelRouting();
  const config = routing.background_extraction_config;

  const lines = [dream_consolidation_prompt, "", "## 待折叠的琐碎事件"];
  eventTexts.forEach((text, i) => lines.push(`${i + 1}. ${text}`));
  lines.push("");
  lines.push('请输出 JSON：{"folded_events": ["概括事件1", "概括事件2"]}');

  const prompt = lines.join("\n");

  const requestMessages = [
    { role: "system" as const, content: "你是一个记忆整理引擎，只输出 JSON。" },
    { role: "user" as const, content: prompt },
  ];
  logDebug("做梦请求", `模型: ${config.model}\n事件: ${eventTexts.length} 条\n\n=== 完整请求 ===\n${requestMessages.map((m, i) => `[${i}] ${m.role.toUpperCase()}\n${m.content}`).join("\n\n")}`);

  try {
    const client = getClient();
    const response = await client.chat.completions.create({
      model: config.model,
      temperature: 0.0,
      response_format: { type: "json_object" },
      messages: requestMessages,
    });

    const text = response.choices[0]?.message?.content;
    logDebug("做梦返回", `=== 完整响应 ===\n${text ?? "（空回复）"}`);
    if (!text) return null;

    const parsed = JSON.parse(text) as { folded_events?: string[] };
    if (!Array.isArray(parsed.folded_events) || parsed.folded_events.length === 0) return null;

    const result = parsed.folded_events.slice(0, 2);
    logDebug("做梦返回", `折叠结果: ${result.join(" | ")}`);
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug("做梦失败", errMsg);
    return null;
  }
}
