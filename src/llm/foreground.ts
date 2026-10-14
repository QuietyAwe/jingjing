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

/** SSE 静默超时：连续这么久收不到任何数据即判定 API 无响应（收到事件即重置） */
const STALL_TIMEOUT_MS = 30_000;
/** 流式整体上限：防止服务端"滴流"长期占坑 */
const OVERALL_STREAM_MS = 180_000;
/** 非流式请求超时（per-request，SDK 会真正中止挂起的请求） */
const NON_STREAM_TIMEOUT_MS = 60_000;

/** 超时提示里附带的排查方向 */
const TIMEOUT_HINT = "请检查网络、Base URL 与 API Key（可在设置页修改）";

/** 超时错误标记：调用方据此跳过降级重试（服务端无响应时重试必然再挂） */
export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmTimeoutError";
  }
}

/** 把 SDK / 网络错误映射为可读中文，并标记是否为超时 */
export function describeError(err: unknown): { message: string; isTimeout: boolean } {
  if (err instanceof LlmTimeoutError) {
    return { message: err.message, isTimeout: true };
  }
  const e = err as { name?: string; status?: number; message?: string } | null;
  // OpenAI SDK 的 per-request 超时
  if (e?.name === "APIConnectionTimeoutError") {
    return {
      message: `请求超时：${NON_STREAM_TIMEOUT_MS / 1000} 秒未收到 API 响应，${TIMEOUT_HINT}`,
      isTimeout: true,
    };
  }
  const status = e?.status;
  if (status === 401 || status === 403) {
    return { message: "API Key 无效或已过期，请在设置页检查", isTimeout: false };
  }
  if (status === 429) {
    return { message: "请求过于频繁，请稍后再试", isTimeout: false };
  }
  if (typeof status === "number" && status >= 500) {
    return { message: "服务端异常，请稍后再试", isTimeout: false };
  }
  const raw = e?.message || String(err);
  if (e?.name === "APIConnectionError" || raw.includes("Network request failed")) {
    return { message: "网络连接失败，请检查网络后重试", isTimeout: false };
  }
  return { message: raw, isTimeout: false };
}

/** 获取思考模式配置 */
function getThinkingConfig() {
  const enabled = useSettingsStore.getState().thinking_mode;
  return {
    type: enabled ? "enabled" : "disabled" as const,
  };
}

/**
 * 非流式调用（per-request 超时由 SDK 执行，会真正中止挂起的请求）
 */
async function chatComplete(
  model: string,
  temperature: number,
  messages: { role: "system" | "user" | "assistant"; content: string }[]
): Promise<{ text: string; thinking: string }> {
  const client = getClient();
  logDebug("API请求", `模型: ${model}\n温度: ${temperature}\n消息数: ${messages.length}\n\n=== 完整请求 ===\n${formatMessagesForLog(messages)}`);

  const res = await client.chat.completions.create(
    {
      model,
      temperature,
      messages,
      // @ts-ignore: DeepSeek thinking 参数
      thinking: getThinkingConfig(),
    },
    // per-request 超时：SDK 到点真正 abort 请求，而不是只 race 不取消
    { timeout: NON_STREAM_TIMEOUT_MS }
  );
  const text = res.choices?.[0]?.message?.content ?? "";
  // @ts-ignore: DeepSeek reasoning_content
  const thinking = res.choices?.[0]?.message?.reasoning_content ?? "";
  logDebug("API返回", `=== 完整响应 ===\n长度: ${text.length}${thinking ? `\n思考: ${thinking.length}字` : ""}${text.length > 0 ? "\n\n" + text : "\n（空回复）"}`);
  return { text, thinking };
}

/**
 * 流式调用（SSE）— 使用 react-native-sse
 *
 * 时间预算：
 * - 静默超时 STALL_TIMEOUT_MS：连续收不到数据即判无响应（收到事件即重置，不误杀慢速长回复）
 * - 整体上限 OVERALL_STREAM_MS：防"滴流"长期占坑
 * 所有退出路径统一清理定时器并关闭连接，避免连接泄漏与并发双请求。
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
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

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

    /** 退出路径统一收口：清定时器 + 关连接，防泄漏与并发双请求 */
    const finish = () => {
      if (stallTimer) clearTimeout(stallTimer);
      if (overallTimer) clearTimeout(overallTimer);
      stallTimer = null;
      overallTimer = null;
      es.close();
    };

    /** 收到任何数据都重置静默计时 */
    const touchStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        finish();
        logDebug(
          "请求超时",
          `模型: ${model}｜静默 ${STALL_TIMEOUT_MS / 1000}s 无数据（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s）`
        );
        reject(
          new LlmTimeoutError(
            `请求超时：${STALL_TIMEOUT_MS / 1000} 秒未收到 API 响应，${TIMEOUT_HINT}`
          )
        );
      }, STALL_TIMEOUT_MS);
    };

    // 静默计时 + 整体上限双保险
    touchStallTimer();
    overallTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      finish();
      logDebug("请求超时", `模型: ${model}｜整体超过 ${OVERALL_STREAM_MS / 1000}s，已中断`);
      reject(
        new LlmTimeoutError(
          `请求超时：响应时间过长（超过 ${Math.round(OVERALL_STREAM_MS / 60000)} 分钟），已中断，请稍后重试`
        )
      );
    }, OVERALL_STREAM_MS);

    es.addEventListener("message", (event) => {
      if (settled) return;
      touchStallTimer();
      const data = event.data;
      if (!data || data === "[DONE]") {
        settled = true;
        finish();
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
      finish();
      // 保留 HTTP 状态码，交给 describeError 映射友好文案
      const status = event?.status;
      const err = new Error(
        event?.message || (status ? `请求失败（HTTP ${status}）` : "SSE 连接错误")
      ) as Error & { status?: number };
      if (status) err.status = status;
      reject(err);
    });
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
 * 连接类错误一次性降级到非流式；超时（服务端无响应）直接报错不再重试
 */
export async function streamChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  callbacks: StreamChatCallbacks
): Promise<void> {
  const routing = getModelRouting();
  const model = routing.foreground_chat_config.model;
  const temperature = routing.foreground_chat_config.temperature;
  const streamOutput = useSettingsStore.getState().stream_output;

  const startedAt = Date.now();
  const succeed = (result: { text: string; thinking: string }) => {
    if (result.text.length > 0) {
      callbacks.onDone(result.text, result.thinking);
    } else {
      callbacks.onError(new Error("模型未返回任何内容，请检查模型名是否正确"));
    }
  };

  try {
    if (streamOutput) {
      // 流式模式
      const result = await chatCompleteStream(
        model,
        temperature,
        messages,
        (delta) => {
          callbacks.onDelta?.(delta);
        },
        (thinking) => {
          callbacks.onThinking?.(thinking);
        }
      );
      succeed(result);
    } else {
      // 非流式模式
      succeed(await chatComplete(model, temperature, messages));
    }
  } catch (err: unknown) {
    const { message, isTimeout } = describeError(err);
    logDebug(
      isTimeout ? "请求超时" : "请求失败",
      `${message}（模型: ${model}，耗时 ${Date.now() - startedAt}ms）`
    );

    // 超时（服务端无响应）不再降级重试——重试必然再挂一轮；
    // 连接类/协议类错误保留一次性降级（兼容不支持 SSE 的端点）
    if (streamOutput && !isTimeout) {
      logDebug("流式降级", "流式请求失败，自动降级到非流式模式");
      try {
        succeed(await chatComplete(model, temperature, messages));
      } catch (fallbackErr: unknown) {
        const fb = describeError(fallbackErr);
        logDebug(
          fb.isTimeout ? "请求超时" : "请求失败",
          `降级非流式后仍失败：${fb.message}（耗时 ${Date.now() - startedAt}ms）`
        );
        callbacks.onError(new Error(fb.message));
      }
    } else {
      callbacks.onError(new Error(message));
    }
  }
}
