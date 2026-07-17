// ============================================================
// P5-2: 后台提取 LLM 客户端
// 调用 gpt-4o-mini (JSON mode) 从对话快照中提取用户信息与记忆片段
// ============================================================

import { getClient } from "./client";
import { getPrompts, getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import type { UserInfo, ConsolidationResponse, MemoryEvent } from "@/types/schema";

/**
 * 构建提取 prompt：拼接 extraction_prompt + user_info + 已有事件 + 对话快照
 */
function buildExtractionPrompt(
  userInfo: UserInfo,
  snapshot: Array<{ role: string; content: string }>,
  existingEvents: MemoryEvent[],
): string {
  const { extraction_prompt } = getPrompts();

  const lines: string[] = [
    extraction_prompt,
    "",
    "## 当前用户信息",
    JSON.stringify(userInfo, null, 2),
    "",
    "## 已有索引事件",
  ];

  if (existingEvents.length === 0) {
    lines.push("（暂无索引事件，请为本次对话创建新事件）");
  } else {
    for (const e of existingEvents) {
      lines.push(`- [id:${e.id}] ${e.event_text}`);
    }
  }

  lines.push("");
  lines.push("## 对话快照（最近 10 轮）");

  for (const msg of snapshot) {
    const tag = msg.role === "user" ? "用户" : "助手";
    lines.push(`[${tag}] ${msg.content}`);
  }

  lines.push("");
  lines.push(
    '请严格输出 JSON，格式：{"updated_user_info": {...}, "new_fragment": {"summary": "...", "emotion": "...", "target_event_index": 数字或-1, "new_event_text": ""}}',
  );

  return lines.join("\n");
}

/**
 * 调用后台 LLM 提取用户信息与记忆片段
 */
export async function extractConsolidation(
  userInfo: UserInfo,
  snapshot: Array<{ role: string; content: string }>,
  existingEvents: MemoryEvent[],
  timeoutMs: number = 30000,
): Promise<ConsolidationResponse | null> {
  const prompt = buildExtractionPrompt(userInfo, snapshot, existingEvents);
  const routing = getModelRouting();
  const config = routing.background_extraction_config;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestMessages = [
    { role: "system" as const, content: "你是一个信息提取引擎，只输出 JSON。" },
    { role: "user" as const, content: prompt },
  ];
  logDebug("巩固请求", `模型: ${config.model}\n温度: ${config.temperature}\n快照: ${snapshot.length} 条\n\n=== 完整请求 ===\n${requestMessages.map((m, i) => `[${i}] ${m.role.toUpperCase()}\n${m.content}`).join("\n\n")}`);

  try {
    const client = getClient();
    const response = await client.chat.completions.create(
      {
        model: config.model,
        temperature: config.temperature,
        response_format: { type: "json_object" },
        messages: requestMessages,
      },
      { signal: controller.signal },
    );

    clearTimeout(timer);

    const text = response.choices[0]?.message?.content;
    logDebug("巩固返回", `=== 完整响应 ===\n${text ?? "（空回复）"}`);
    if (!text) {
      return null;
    }

    const parsed = JSON.parse(text) as ConsolidationResponse;

    if (!parsed.updated_user_info || !parsed.new_fragment) {
      logDebug("巩固返回", `JSON 缺少字段\n${text.slice(0, 200)}`);
      return null;
    }
    if (!parsed.new_fragment.summary || !parsed.new_fragment.emotion) {
      logDebug("巩固返回", `fragment 缺少字段\n${text.slice(0, 200)}`);
      return null;
    }
    if (parsed.new_fragment.target_event_index === undefined) {
      parsed.new_fragment.target_event_index = -1;
    }

    logDebug("巩固返回", `摘要: ${parsed.new_fragment.summary}\n情绪: ${parsed.new_fragment.emotion}`);
    return parsed;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      logDebug("巩固超时", `${timeoutMs}ms 已丢弃`);
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      logDebug("巩固失败", errMsg);
    }
    return null;
  }
}
