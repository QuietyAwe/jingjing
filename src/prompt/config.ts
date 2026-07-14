import type { AppConfig, DefaultPlaceholders } from "@/types/schema";
import defaultConfigData from "./defaultConfig.json";

const config: AppConfig = defaultConfigData as AppConfig;

/** 获取完整配置 */
export function getConfig(): AppConfig {
  return config;
}

/** 获取 prompts 配置 */
export function getPrompts() {
  return config.prompts;
}

/** 获取模型路由配置 */
export function getModelRouting() {
  return config.model_routing;
}

/** 获取阈值配置 */
export function getThresholds() {
  return config.thresholds;
}

/** 获取衰减配置 */
export function getWeightDecay() {
  return config.weight_decay;
}

/**
 * 安全获取 default_placeholders，缺失字段兜底
 * 对齐 PRD 4.3 节 default_placeholders
 */
export function getPlaceholders(): Required<DefaultPlaceholders> {
  const defaults: DefaultPlaceholders = {
    nickname: "你",
    location: "未知地方",
    occupation: "神秘职业",
    comm_preference: "喜欢温柔诚恳的沟通风格",
  };

  return {
    nickname: config.default_placeholders?.nickname ?? defaults.nickname,
    location: config.default_placeholders?.location ?? defaults.location,
    occupation: config.default_placeholders?.occupation ?? defaults.occupation,
    comm_preference:
      config.default_placeholders?.comm_preference ?? defaults.comm_preference,
  };
}
