// ============================================================
// P4-3: 前台 LLM 客户端
// React Native 环境不支持 ReadableStream，直接使用非流式调用
// ============================================================

import { getClient } from "./client";
import { getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";

/** 格式化消息列表用于日志显示（不截断） */
function formatMessagesForLog(msgs: { role: string; content: string }[]): string {
  return msgs.map((m, i) => `[${i}] ${m.role.toUpperCase()}\n${m.content}`).join("\n\n");
}

/** 超时时间（毫秒） */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * 带超时的 Promise 包装
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("请求超时")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * 非流式调用（RN 不支持流式 ReadableStream）
 */
async function chatComplete(
  model: string,
  temperature: number,
  messages: { role: "system" | "user" | "assistant"; content: string }[]
): Promise<string> {
  const client = getClient();
  logDebug("API请求", `模型: ${model}\n温度: ${temperature}\n消息数: ${messages.length}\n\n=== 完整请求 ===\n${formatMessagesForLog(messages)}`);

  const res = await client.chat.completions.create({
    model,
    temperature,
    messages,
  });
  const text = res.choices?.[0]?.message?.content ?? "";
  logDebug("API返回", `=== 完整响应 ===\n长度: ${text.length}${text.length > 0 ? "\n\n" + text : "\n（空回复）"}`);
  return text;
}

export interface StreamChatCallbacks {
  onDelta?: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

/**
 * 前台聊天（RN 环境，非流式）
 * onDelta 保留接口兼容，实际一次性回调 onDone
 */
export async function streamChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  callbacks: StreamChatCallbacks
): Promise<void> {
  const routing = getModelRouting();
  const model = routing.foreground_chat_config.model;
  const temperature = routing.foreground_chat_config.temperature;

  try {
    const result = await withTimeout(chatComplete(model, temperature, messages), REQUEST_TIMEOUT_MS);
    if (result.length > 0) {
      callbacks.onDone(result);
    } else {
      callbacks.onError(new Error("模型未返回任何内容，请检查模型名是否正确"));
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug("请求失败", errMsg);
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
