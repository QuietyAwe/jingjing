// ============================================================
// 20问题材选择
//
// 优先从「共同记忆」里取材（这样游戏是在回忆共同经历），
// 记忆不足或已用尽时回退到公共知名题材，保证一直有得玩。
// ============================================================

import { getClient } from "@/llm/client";
import { getModelRouting } from "@/prompt/config";
import { logDebug } from "@/store/chatStore";
import { getUserInfo, getTopActive, getRecentSecrets } from "@/db/queries";
import { stripFence } from "./judge";

export interface PickedSubject {
  secret: string;
  source: "memory" | "public";
}

const PICKER_SYSTEM = `你在为一个「20问」游戏挑选谜底。玩家会通过只能回答是/否的问题来猜它。

要求：
- 必须是一个具体的、可被猜到的人/角色/地点/物品/作品，不能是抽象概念
- 难度适中：太冷门猜不到，太宽泛（如"水"）不好玩
- 优先从「共同记忆」里选，那会让玩家觉得你记得和他一起经历过的事
- 如果共同记忆不合适或已用尽，就从公共知名题材里选（大众熟悉的公众人物、影视角色、名著、知名地点）
- 绝对不要选择「已经用过的谜底」里的任何一项

严格输出 JSON：{"secret":"谜底","source":"memory|public","why":"一句话说明为什么选它"}`;

/**
 * 挑选一个谜底
 */
export async function pickSubject(): Promise<PickedSubject | null> {
  const userInfo = getUserInfo();
  const events = getTopActive(20);
  const used = getRecentSecrets(20);

  const memoryLines: string[] = [];
  if (userInfo) {
    if (userInfo.social_graph.length > 0) {
      memoryLines.push(`认识的人：${userInfo.social_graph.map((s) => s.name).join("、")}`);
    }
    if (userInfo.preferences.likes.length > 0) {
      memoryLines.push(`喜欢：${userInfo.preferences.likes.join("、")}`);
    }
    if (userInfo.life_quests.long_term_goals.length > 0) {
      memoryLines.push(`愿望：${userInfo.life_quests.long_term_goals.join("、")}`);
    }
  }
  const eventTexts = events.map((e) => e.event_text).filter(Boolean);
  if (eventTexts.length > 0) {
    memoryLines.push(`共同经历：${eventTexts.join("、")}`);
  }

  const userPrompt = [
    `## 共同记忆（优先取材）`,
    memoryLines.length > 0 ? memoryLines.join("\n") : "（暂无共同记忆，请用公共题材）",
    ``,
    `## 已经用过的谜底（禁止重复）`,
    used.length > 0 ? used.join("、") : "（无）",
    ``,
    `请输出 JSON。`,
  ].join("\n");

  try {
    const client = getClient();
    const routing = getModelRouting();
    const response = await client.chat.completions.create({
      model: routing.background_extraction_config.model,
      temperature: 0.9,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PICKER_SYSTEM },
        { role: "user", content: userPrompt },
      ],
    });
    const text = response.choices[0]?.message?.content;
    if (!text) return null;
    const parsed = JSON.parse(stripFence(text)) as {
      secret?: string;
      source?: "memory" | "public";
      why?: string;
    };
    if (!parsed.secret) return null;
    logDebug("20问出题", `谜底=${parsed.secret} 来源=${parsed.source ?? "public"}`);
    return {
      secret: parsed.secret.trim(),
      source: parsed.source === "memory" ? "memory" : "public",
    };
  } catch (err) {
    logDebug("20问出题失败", err instanceof Error ? err.message : String(err));
    return null;
  }
}
