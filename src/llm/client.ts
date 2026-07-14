// ============================================================
// OpenAI SDK 客户端初始化
// ============================================================

import OpenAI from "openai";

// API Key 从环境变量或 AsyncStorage 读取，此处为默认占位
let _client: OpenAI | null = null;

/**
 * 获取 OpenAI 客户端单例
 * @param apiKey 可选，首次调用或需要切换 key 时传入
 */
export function getClient(apiKey?: string): OpenAI {
  if (!_client && apiKey) {
    _client = new OpenAI({ apiKey });
  }
  if (!_client) {
    throw new Error("OpenAI client not initialized. Call setApiKey first.");
  }
  return _client;
}

/** 设置 API Key 并重新初始化客户端 */
export function setApiKey(apiKey: string): void {
  _client = new OpenAI({ apiKey });
}

/** 检查是否已配置 API Key */
export function hasApiKey(): boolean {
  return _client !== null;
}
