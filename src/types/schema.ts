// ============================================================
// 核心类型定义 — 对齐 PRD 第 4 节数据模型契约
// ============================================================

// --- PRD 4.1 表结构 ---

/** 记忆片段表 (memory_fragments) */
export interface MemoryFragment {
  id: number;
  /** 关联的父级记忆事件 ID */
  index: number;
  /** ISO8601 格式时间戳 */
  timestamp: string;
  /** 50 字以内概要 */
  summary: string;
  /** 情绪状态描述 */
  emotion: string;
}

/** 记忆事件表 (memory_events) */
export interface MemoryEvent {
  id: number;
  /** 索引记忆事件自增 ID */
  index: number;
  event_text: string;
  timestamp: string;
  /** 活跃权重 1-100 */
  active_weight: number;
  last_accessed: string;
  /** 0: 活跃, 1: 软归档 */
  is_archived: 0 | 1;
}

/** 系统元数据表 (system_metadata) */
export interface SystemMetadata {
  key: string;
  value: string;
}

// --- PRD 4.4 后台模型提取契约 ---

export interface BasicIdentity {
  nickname: string;
  gender: string;
  birthday: string;
  occupation: string;
  location: string;
}

export interface Preferences {
  likes: string[];
  dislikes: string[];
}

export interface SocialGraphEntry {
  name: string;
  role: string;
  attitude: string;
}

export interface PsychoState {
  personality_traits: string[];
  current_stressors: string[];
  comm_preference: string;
}

export interface OngoingTask {
  task_name: string;
  status: string;
}

export interface LifeQuests {
  long_term_goals: string[];
  ongoing_tasks: OngoingTask[];
}

/** 用户信息 (user_info 表存储结构) */
export interface UserInfo {
  basic_identity: BasicIdentity;
  preferences: Preferences;
  social_graph: SocialGraphEntry[];
  psycho_state: PsychoState;
  life_quests: LifeQuests;
}

/** 后台模型返回的新记忆片段 */
export interface NewFragment {
  summary: string;
  emotion: string;
  /** 非空时代表属于全新事件主题 */
  target_event_text: string;
}

/** 后台模型提取完整响应 (PRD 4.4) */
export interface ConsolidationResponse {
  updated_user_info: UserInfo;
  new_fragment: NewFragment;
}

// --- PRD 4.3 配置契约 ---

export interface PromptsConfig {
  system_prompt: string;
  extraction_prompt: string;
  state_injection_template: string;
  dream_consolidation_prompt: string;
  cold_start_template: string;
}

export interface DefaultPlaceholders {
  nickname: string;
  location: string;
  occupation: string;
  comm_preference: string;
}

export interface ThresholdsConfig {
  consolidation_window_turns: number;
  context_active_events_limit: number;
}

export interface WeightDecayConfig {
  ebbinghaus_decay_rate: number;
  epiphany_trigger_probability: number;
}

export interface ModelConfig {
  model: string;
  temperature: number;
  response_format?: { type: string };
}

export interface ModelRoutingConfig {
  background_extraction_config: ModelConfig;
  foreground_chat_config: ModelConfig;
}

/** 应用配置 (PRD 4.3 app_config) */
export interface AppConfig {
  prompts: PromptsConfig;
  default_placeholders: DefaultPlaceholders;
  thresholds: ThresholdsConfig;
  weight_decay: WeightDecayConfig;
  model_routing: ModelRoutingConfig;
}

// --- 聊天相关 ---

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}
