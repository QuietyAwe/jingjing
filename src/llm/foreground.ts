// ============================================================
// P4-3: 前台聊天模型调用（流式输出）
// 对齐 PRD model_routing.foreground_chat_config
// ============================================================

import { getClient } from "./client";
import { getModelRouting } from "@/prompt/config";
import type { ChatMessage } from "@/types/schema";

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

/**
 * 调用前台聊天模型（流式）
 * @param systemPrompt 系统 prompt
 * @param history 对话历史
 * @param callbacks 流式回调
 */
export async function streamChat(
  systemPrompt: string,
  history: { role: "user" | "assistant"; content: string }[],
  callbacks: StreamCallbacks
): Promise<void> {
  const config = getModelRouting().foreground_chat_config;

  try {
    const client = getClient();

    const stream = await client.chat.completions.create({
      model: config.model,
      temperature: config.temperature,
      messages: [{ role: "system", content: systemPrompt }, ...history],
      stream: true,
    });

    let fullText = "";

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        callbacks.onDelta(delta);
      }
    }

    callbacks.onDone(fullText);
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "网络异常，请检查连接后重试";
    callbacks.onError(msg);
  }
}

/**
 * 非流式调用（用于后台巩固等场景）
 */
export async function chatComplete(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const config = getModelRouting().foreground_chat_config;

  try {
    const client = getClient();
    const response = await client.chat.completions.create({
      model: config.model,
      temperature: config.temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });
    return response.choices[0]?.message?.content ?? "";
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "网络异常";
    throw new Error(msg);
  }
}
