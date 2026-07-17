import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AppConfig, DefaultPlaceholders } from "@/types/schema";
import defaultConfigData from "./defaultConfig.json";

const config: AppConfig = defaultConfigData as AppConfig;
const OVERRIDES_KEY = "config_overrides";

// 内存缓存
let overrides: Record<string, string> = {};
let cacheLoaded = false;

// ============================================================
// 通用覆盖机制
// ============================================================

/** 启动时加载所有配置覆盖 */
export async function loadConfigOverrides(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(OVERRIDES_KEY);
    overrides = raw ? JSON.parse(raw) : {};
  } catch {
    overrides = {};
  }
  cacheLoaded = true;
}

/** 获取覆盖值（数字自动转换） */
function getOverride(key: string, defaultValue: number): number;
function getOverride(key: string, defaultValue: string): string;
function getOverride(key: string, defaultValue: number | string): number | string {
  if (!cacheLoaded) return defaultValue;
  const val = overrides[key];
  if (val === undefined) return defaultValue;
  if (typeof defaultValue === "number") return parseFloat(val) || defaultValue;
  return val;
}

/** 设置覆盖值 */
export async function setConfigOverride(key: string, value: string): Promise<void> {
  overrides[key] = value;
  await AsyncStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
}

/** 恢复单个配置为默认值 */
export async function resetConfigOverride(key: string): Promise<void> {
  delete overrides[key];
  await AsyncStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
}

/** 恢复所有配置为默认值 */
export async function resetAllConfigOverrides(): Promise<void> {
  overrides = {};
  await AsyncStorage.removeItem(OVERRIDES_KEY);
}

/** 获取默认值（用于显示"恢复默认"） */
export function getConfigDefault(key: string): string {
  const thresholds = config.thresholds;
  const decay = config.weight_decay;
  const bg = config.model_routing.background_extraction_config;
  const fg = config.model_routing.foreground_chat_config;

  const defaults: Record<string, string> = {
    consolidation_window_turns: String(thresholds.consolidation_window_turns),
    context_active_events_limit: String(thresholds.context_active_events_limit),
    ebbinghaus_decay_rate: String(decay.ebbinghaus_decay_rate),
    epiphany_trigger_probability: String(decay.epiphany_trigger_probability),
    background_model: bg.model,
    background_temperature: String(bg.temperature),
    foreground_model: fg.model,
    foreground_temperature: String(fg.temperature),
    context_template: config.prompts.context_template,
    extraction_prompt: config.prompts.extraction_prompt,
    state_injection_template: config.prompts.state_injection_template,
    dream_consolidation_prompt: config.prompts.dream_consolidation_prompt,
    cold_start_template: config.prompts.cold_start_template,
  };
  return defaults[key] ?? "";
}

// ============================================================
// 系统提示词（保留独立接口，向后兼容）
// ============================================================

export function getSystemPrompt(): string {
  return getOverride("system_prompt", config.prompts.system_prompt);
}

export function getDefaultSystemPrompt(): string {
  return config.prompts.system_prompt;
}

export async function setCustomSystemPrompt(prompt: string): Promise<void> {
  if (!prompt.trim()) {
    await resetConfigOverride("system_prompt");
  } else {
    await setConfigOverride("system_prompt", prompt.trim());
  }
}

// ============================================================
// 各类配置 getter（带覆盖支持）
// ============================================================

/** 获取 prompts 配置 */
export function getPrompts() {
  return {
    system_prompt: getOverride("system_prompt", config.prompts.system_prompt),
    extraction_prompt: getOverride("extraction_prompt", config.prompts.extraction_prompt),
    state_injection_template: getOverride("state_injection_template", config.prompts.state_injection_template),
    dream_consolidation_prompt: getOverride("dream_consolidation_prompt", config.prompts.dream_consolidation_prompt),
    cold_start_template: getOverride("cold_start_template", config.prompts.cold_start_template),
    context_template: getOverride("context_template", config.prompts.context_template),
    memory_injection_template: getOverride("memory_injection_template", config.prompts.memory_injection_template),
    memory_event_template: getOverride("memory_event_template", config.prompts.memory_event_template),
  };
}

/** 获取模型路由配置 */
export function getModelRouting() {
  return {
    background_extraction_config: {
      model: getOverride("background_model", config.model_routing.background_extraction_config.model),
      temperature: getOverride("background_temperature", config.model_routing.background_extraction_config.temperature),
      response_format: config.model_routing.background_extraction_config.response_format,
    },
    foreground_chat_config: {
      model: getOverride("foreground_model", config.model_routing.foreground_chat_config.model),
      temperature: getOverride("foreground_temperature", config.model_routing.foreground_chat_config.temperature),
    },
  };
}

/** 获取阈值配置 */
export function getThresholds() {
  return {
    consolidation_window_turns: getOverride("consolidation_window_turns", config.thresholds.consolidation_window_turns),
    context_active_events_limit: getOverride("context_active_events_limit", config.thresholds.context_active_events_limit),
  };
}

/** 获取衰减配置 */
export function getWeightDecay() {
  return {
    ebbinghaus_decay_rate: getOverride("ebbinghaus_decay_rate", config.weight_decay.ebbinghaus_decay_rate),
    epiphany_trigger_probability: getOverride("epiphany_trigger_probability", config.weight_decay.epiphany_trigger_probability),
  };
}

/**
 * 安全获取 default_placeholders，缺失字段兜底
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
