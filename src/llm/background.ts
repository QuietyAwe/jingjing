// ============================================================
// P5-2: 后台提取 LLM 客户端
// 调用 gpt-4o-mini (JSON mode) 从对话快照中提取用户信息与记忆片段
// ============================================================

import { getClient } from "./client";
import { getPrompts, getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import type { UserInfo, ConsolidationResponse, MemoryEvent } from "@/types/schema";
import type { ScheduleItem } from "@/db/queries";

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
    '请严格输出 JSON，格式：{"updated_user_info": {...}, "new_fragment": {"summary": "...", "emotion": "...", "priority": 数字1-9, "target_event_index": 数字或-1, "new_event_text": ""}}',
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
    if (parsed.new_fragment.priority === undefined || parsed.new_fragment.priority < 1 || parsed.new_fragment.priority > 9) {
      parsed.new_fragment.priority = 5;
    }

    logDebug("巩固返回", `摘要: ${parsed.new_fragment.summary}\n情绪: ${parsed.new_fragment.emotion}\n优先级: ${parsed.new_fragment.priority}`);
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

/**
 * 生成每周行为时间表
 * @param systemPrompt 系统人设提示词（AI 的人设）
 */
export async function generateSchedule(
  systemPrompt: string,
  lastWeekSchedule: ScheduleItem[],
  timeoutMs: number = 30000,
): Promise<ScheduleItem[] | null> {
  const { schedule_generation_prompt } = getPrompts();
  const routing = getModelRouting();
  const config = routing.background_extraction_config;

  // 构建上周时间表文本
  let lastWeekText = "（无上周时间表）";
  if (lastWeekSchedule.length > 0) {
    const lines: string[] = [];
    const dayLabels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    const slotLabels = ["早(6-9)", "上午(9-12)", "午(12-15)", "下午(15-18)", "晚(18-23)"];

    for (let day = 0; day < 7; day++) {
      const dayItems = lastWeekSchedule.filter(s => s.day_of_week === day);
      if (dayItems.length > 0) {
        lines.push(`${dayLabels[day]}：${dayItems.map(i => `${slotLabels[i.time_slot]}=${i.activity}`).join("，")}`);
      }
    }
    lastWeekText = lines.join("\n") || "（无上周时间表）";
  }

  const prompt = (schedule_generation_prompt || DEFAULT_SCHEDULE_PROMPT)
    .replace("{{persona}}", systemPrompt)
    .replace("{{last_week}}", lastWeekText);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestMessages = [
    { role: "system" as const, content: "你是一个生活规划引擎，只输出 JSON。" },
    { role: "user" as const, content: prompt },
  ];
  logDebug("时间表请求", `模型: ${config.model}\n\n=== 完整请求 ===\n${requestMessages.map((m, i) => `[${i}] ${m.role.toUpperCase()}\n${m.content}`).join("\n\n")}`);

  try {
    const client = getClient();
    const response = await client.chat.completions.create(
      {
        model: config.model,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: requestMessages,
      },
      { signal: controller.signal },
    );

    clearTimeout(timer);

    const text = response.choices[0]?.message?.content;
    logDebug("时间表返回", `=== 完整响应 ===\n${text ?? "（空回复）"}`);
    if (!text) return null;

    const parsed = JSON.parse(text) as { schedule?: Array<{ day: number; slot: number; activity: string }> };
    if (!Array.isArray(parsed.schedule) || parsed.schedule.length === 0) {
      logDebug("时间表返回", "schedule 字段为空");
      return null;
    }

    // 验证并转换格式
    const items: ScheduleItem[] = parsed.schedule
      .filter(s => s.day >= 0 && s.day <= 6 && s.slot >= 0 && s.slot <= 4 && s.activity)
      .map(s => ({
        day_of_week: s.day,
        time_slot: s.slot,
        activity: s.activity.slice(0, 20),
      }));

    logDebug("时间表返回", `解析成功: ${items.length} 条`);
    return items;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      logDebug("时间表超时", `${timeoutMs}ms 已丢弃`);
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      logDebug("时间表失败", errMsg);
    }
    return null;
  }
}

const DEFAULT_SCHEDULE_PROMPT = `请根据以下人设信息，生成一份本周的行为时间表。

## 人设信息
{{persona}}

## 上周时间表（参考）
{{last_week}}

## 要求
1. 根据人设推断合理的日常作息
2. 工作日和周末要有区别
3. 活动描述简洁（20字以内），生活化
4. 可以有重复，但不要每天都完全一样
5. 周末可以安排休闲、社交活动

## 输出格式
JSON 对象，包含 schedule 数组，每个元素：
- day: 0-6（0=周一，6=周日）
- slot: 0-4（0=早6-9点，1=上午9-12点，2=午12-15点，3=下午15-18点，4=晚18-23点）
- activity: 活动描述（20字以内）

输出示例：
{"schedule": [{"day": 0, "slot": 0, "activity": "晨跑"}, ...]}`;
