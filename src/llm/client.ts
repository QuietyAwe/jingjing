// ============================================================
// OpenAI SDK 客户端初始化
// ============================================================

import OpenAI from "openai";

let _client: OpenAI | null = null;
let _apiKey: string | null = null;
let _baseUrl: string | null = null;

function _rebuild(): OpenAI {
  if (!_apiKey) {
    throw new Error("OpenAI client not initialized. Call setApiKey first.");
  }
  _client = new OpenAI({
    apiKey: _apiKey,
    ...(_baseUrl ? { baseURL: _baseUrl } : {}),
    dangerouslyAllowBrowser: true,
  });
  return _client;
}

/**
 * 获取 OpenAI 客户端单例
 */
export function getClient(): OpenAI {
  if (!_client) {
    return _rebuild();
  }
  return _client;
}

/** 设置 API Key 并重新初始化客户端 */
export function setApiKey(apiKey: string): void {
  _apiKey = apiKey;
  _client = null;
}

/** 设置 Base URL 并重新初始化客户端 */
export function setBaseUrl(url: string): void {
  _baseUrl = url;
  _client = null;
}

/** 检查是否已配置 API Key */
export function hasApiKey(): boolean {
  return _apiKey !== null;
}

/** 获取可用模型列表 */
export async function fetchModels(): Promise<string[]> {
  const client = getClient();
  const res = await client.models.list();
  const models = res.data
    .map((m) => m.id)
    .filter((id) => !id.includes("whisper") && !id.includes("tts") && !id.includes("dall") && !id.includes("embedding"))
    .sort();
  return models;
}
