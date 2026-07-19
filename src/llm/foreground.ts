// ============================================================
// P4-3: 前台 LLM 客户端
// 支持流式输出（SSE）和非流式输出，通过设置切换
// ============================================================

import { getClient } from "./client";
import { getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import { useSettingsStore } from "@/store/settingsStore";
import EventSource from "react-native-sse";

/** 格式化消息列表用于日志显示（不截断） */
function formatMessagesForLog(msgs: { role: string; content: string }[]): string {
  return msgs.map((m, i) => `[${i}] ${m.role.toUpperCase()}\n${m.content}`).join("\n\n");
}

/** 超时时间（毫秒） */
const REQUEST_TIMEOUT_MS = 60_000;

/** 获取思考模式配置 */
function getThinkingConfig() {
  const enabled = useSettingsStore.getState().thinking_mode;
  return {
    type: enabled ? "enabled" : "disabled" as const,
  };
}

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
 * 非流式调用
 */
async function chatComplete(
  model: string,
  temperature: number,
  messages: { role: "system" | "user" | "assistant"; content: string }[]
): Promise<{ text: string; thinking: string }> {
  const client = getClient();
  logDebug("API请求", `模型: ${model}\n温度: ${temperature}\n消息数: ${messages.length}\n\n=== 完整请求 ===\n${formatMessagesForLog(messages)}`);

  const res = await client.chat.completions.create({
    model,
    temperature,
    messages,
    // @ts-ignore: DeepSeek thinking 参数
    thinking: getThinkingConfig(),
  });
  const text = res.choices?.[0]?.message?.content ?? "";
  // @ts-ignore: DeepSeek reasoning_content
  const thinking = res.choices?.[0]?.message?.reasoning_content ?? "";
  logDebug("API返回", `=== 完整响应 ===\n长度: ${text.length}${thinking ? `\n思考: ${thinking.length}字` : ""}${text.length > 0 ? "\n\n" + text : "\n（空回复）"}`);
  return { text, thinking };
}

/**
 * 流式调用（SSE）— 使用 react-native-sse
 */
async function chatCompleteStream(
  model: string,
  temperature: number,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  onDelta: (text: string) => void,
  onThinking?: (thinking: string) => void
): Promise<{ text: string; thinking: string }> {
  const apiKey = useSettingsStore.getState().apiKey;
  const baseUrl = useSettingsStore.getState().baseUrl || "https://api.openai.com";

  logDebug("API请求(流式)", `模型: ${model}\n温度: ${temperature}\n消息数: ${messages.length}\n\n=== 完整请求 ===\n${formatMessagesForLog(messages)}`);

  return new Promise<{ text: string; thinking: string }>((resolve, reject) => {
    let fullText = "";
    let fullThinking = "";
    let settled = false;

    // react-native-sse 用 POST + body 的方式
    const url = `${baseUrl}/v1/chat/completions`;
    const es = new EventSource(url, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      method: "POST",
      body: JSON.stringify({
        model,
        temperature,
        messages,
        stream: true,
        thinking: getThinkingConfig(),
      }),
    });

    es.addEventListener("message", (event) => {
      if (settled) return;
      const data = event.data;
      if (!data || data === "[DONE]") {
        settled = true;
        es.close();
        logDebug("API返回(流式)", `=== 完整响应 ===\n长度: ${fullText.length}${fullThinking ? `\n思考: ${fullThinking.length}字` : ""}${fullText.length > 0 ? "\n\n" + fullText : "\n（空回复）"}`);
        resolve({ text: fullText, thinking: fullThinking });
        return;
      }

      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onDelta(delta);
        }
        // DeepSeek thinking delta（字段名是 reasoning_content）
        // @ts-ignore: DeepSeek reasoning_content
        const thinkingDelta = json.choices?.[0]?.delta?.reasoning_content;
        if (thinkingDelta) {
          fullThinking += thinkingDelta;
          onThinking?.(thinkingDelta);
        }
      } catch {
        // 解析失败，跳过
      }
    });

    es.addEventListener("error", (event: any) => {
      if (settled) return;
      settled = true;
      es.close();
      reject(new Error(event?.message || "SSE 连接错误"));
    });

    // 超时保护
    setTimeout(() => {
      if (!settled) {
        settled = true;
        es.close();
        reject(new Error("请求超时"));
      }
    }, REQUEST_TIMEOUT_MS);
  });
}

export interface StreamChatCallbacks {
  onDelta?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onDone: (fullText: string, thinking: string) => void;
  onError: (err: Error) => void;
}

/**
 * 前台聊天（支持流式/非流式切换）
 * 流式失败时自动降级到非流式
 */
export async function streamChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  callbacks: StreamChatCallbacks
): Promise<void> {
  const routing = getModelRouting();
  const model = routing.foreground_chat_config.model;
  const temperature = routing.foreground_chat_config.temperature;
  const streamOutput = useSettingsStore.getState().stream_output;

  try {
    if (streamOutput) {
      // 流式模式
      const result = await withTimeout(
        chatCompleteStream(model, temperature, messages, (delta) => {
          callbacks.onDelta?.(delta);
        }, (thinking) => {
          callbacks.onThinking?.(thinking);
        }),
        REQUEST_TIMEOUT_MS
      );
      if (result.text.length > 0) {
        callbacks.onDone(result.text, result.thinking);
      } else {
        callbacks.onError(new Error("模型未返回任何内容，请检查模型名是否正确"));
      }
    } else {
      // 非流式模式
      const result = await withTimeout(chatComplete(model, temperature, messages), REQUEST_TIMEOUT_MS);
      if (result.text.length > 0) {
        callbacks.onDone(result.text, result.thinking);
      } else {
        callbacks.onError(new Error("模型未返回任何内容，请检查模型名是否正确"));
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logDebug("请求失败", errMsg);

    // 流式失败时自动降级到非流式
    if (streamOutput) {
      logDebug("流式降级", "流式请求失败，自动降级到非流式模式");
      try {
        const result = await withTimeout(chatComplete(model, temperature, messages), REQUEST_TIMEOUT_MS);
        if (result.text.length > 0) {
          callbacks.onDone(result.text, result.thinking);
        } else {
          callbacks.onError(new Error("模型未返回任何内容，请检查模型名是否正确"));
        }
      } catch (fallbackErr: unknown) {
        callbacks.onError(fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
      }
    } else {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
