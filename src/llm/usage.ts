// ============================================================
// 响应用量解析：前台流式、后台判定共用
// ============================================================

import type { LlmUsage } from "@/store/chatStore";

/** 响应里的 usage 字段（DeepSeek / OpenAI 兼容端点字段名不一，两处都认） */
export type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

/** 取出「prompt / 命中缓存 / completion」三个数，取不到就当没有 */
export function pickUsage(raw: RawUsage | undefined): LlmUsage | null {
  if (!raw?.prompt_tokens) return null;
  return {
    promptTokens: raw.prompt_tokens,
    cachedTokens: raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
  };
}
