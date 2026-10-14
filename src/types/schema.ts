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
  /** 一句话概要（20 字以内）：记忆变淡后只留下的那个印象 */
  gist: string;
  /** 120 字以内概要：发生了什么 + 关键细节 + 当时情绪（情绪已并入此字段） */
  summary: string;
  /** 关键词索引（逗号分隔）：写入时由 LLM 抽取，含同义/别称，供检索匹配 */
  keywords: string;
  /** 重要性权重 1-9（1-3琐事，4-6中等，7-9重大） */
  priority: number;
}

/** 记忆类型：决定衰减速度，模拟真实记忆的分层 */
export type MemoryKind =
  /** 日常琐事：按小时衰减，几天内淡忘 */
  | "daily"
  /** 共同经历（游戏、深度对话等）：按天衰减且有下限，数月甚至数年后仍可被想起 */
  | "episode";

/** 记忆事件表 (memory_events) */
export interface MemoryEvent {
  id: number;
  event_text: string;
  timestamp: string;
  /** 活跃权重 1-100 */
  active_weight: number;
  last_accessed: string;
  /** 重要性权重 1-9（1-3琐事，4-6中等，7-9重大） */
  priority: number;
  /** 记忆类型，影响衰减模型（旧数据默认 daily） */
  memory_kind: MemoryKind;
}

// --- 游戏会话 ---

export type GameType = "twenty_questions" | "yacht" | "bomb" | "truth_or_dare";
/** user_asks：AI 出题、用户提问；ai_asks：用户出题、AI 提问 */
export type GameMode = "user_asks" | "ai_asks";
export type GameStatus = "playing" | "won" | "lost" | "abandoned" | "tie";
/** 用户单句在游戏语境下的意图 */
export type GameIntent =
  | "question"
  | "guess"
  | "chitchat"
  | "give_up"
  | "rule_query";

/** 一回合问答流水 */
export interface GameTurn {
  /** 用户原话 */
  text: string;
  intent: GameIntent;
  /** 判定结果（仅 question） */
  answer?: "yes" | "no" | "unknown";
  /** 判定依据（仅 question） */
  reason?: string;
  /** 用户猜的内容（仅 guess） */
  guess?: string;
  /** 猜中与否（仅 guess） */
  correct?: boolean;
  at: string;
}

/** 游戏会话表 (game_sessions) */
export interface GameSession {
  id: number;
  game_type: GameType;
  mode: GameMode;
  status: GameStatus;
  /** 谜底（user_asks 模式下为 AI 所想，对 UI 可见但对用户需保密） */
  secret: string;
  /** 题材来源：memory=取自共同记忆，public=公共知名题材 */
  secret_source: "memory" | "public";
  /** 已用的提问数（chitchat 不计） */
  question_count: number;
  /** JSON 序列化的 GameTurn[] */
  turns: string;
  started_at: string;
  ended_at: string | null;
  result_note: string | null;
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

export interface SocialGraphEntry {
  name: string;
  role: string;
  attitude: string;
}

/**
 * 状态（有时效的事实）：如「[time]开始发烧」「[time]在疯狂加班」
 * text 含 [time] 占位符，注入时按 created_at 渲染成相对时间（「7天前开始发烧」）；
 * 超过 STATE_EXPIRE_DAYS 未再被提及即停止注入（数据保留，等记忆区找回）
 */
export interface StateItem {
  text: string;
  /** 写入 / 最近一次被提及时刻 ISO8601（重提会刷新） */
  created_at: string;
}

/**
 * 事件（有到期时间的约定/安排/待办）：如「周五下午面试」
 * 生命周期：upcoming（未到期，到期前 24h 注入临近提示）→
 * caring（已过期未被提起，注入关心里；用户提起或满 48h 归档）→
 * archived（归档，同时转成一条状态供后续关心）
 */
export interface EventItem {
  text: string;
  /** 到期时间 ISO8601 */
  due_time: string;
  created_at: string;
  status: "upcoming" | "caring" | "archived";
  /** 进入 caring 的时刻（48h 自动归档从这算） */
  expired_at?: string;
}

/** 用户信息 (user_info 表存储结构) — 属性/状态/事件 三桶 */
export interface UserInfo {
  basic_identity: BasicIdentity;
  social_graph: SocialGraphEntry[];
  /** 属性（Trait）：永久有效的事实（喜好/性格/沟通偏好/长期目标…） */
  traits: string[];
  /** 状态（State）：有时效的事实 */
  states: StateItem[];
  /** 事件（Event）：有到期时间的约定/安排 */
  events: EventItem[];
}

/** 后台模型返回的新记忆片段 */
export interface NewFragment {
  /** 一句话概要（20 字以内），记忆变淡后只显示这一句 */
  gist: string;
  summary: string;
  /** 关键词（2~6 个，含同义/别称），供后续检索匹配 */
  keywords?: string[];
  /** 重要性权重 1-9（1-3琐事，4-6中等，7-9重大） */
  priority: number;
  /** 挂靠的已有索引事件 ID，-1 表示需要新建 */
  target_event_index: number;
  /** target_event_index 为 -1 时，新建事件的索引文本 */
  new_event_text: string;
}

/** 后台模型提取响应 — 增量模式 (PRD 4.4) */
export interface ConsolidationResponse {
  /** 本次对话中新发现的用户信息（增量，不含旧数据） */
  new_info: {
    basic_identity?: Partial<BasicIdentity>;
    social_graph?: SocialGraphEntry[];
    /** 属性（永久有效），如「喜欢吃番茄炒蛋」 */
    traits?: string[];
    /** 状态（有时效），文本含 [time] 占位符，如「[time]开始发烧」 */
    states?: string[];
    /** 事件（有到期时间的约定/安排），due_time 为 ISO8601 */
    events?: Array<{ text: string; due_time: string }>;
  };
  /** 本次提取出的记忆片段（一次巩固可覆盖多个话题，见 B4） */
  new_fragments?: NewFragment[];
  /** 兼容旧结构：单条片段 */
  new_fragment?: NewFragment;
}

// --- PRD 4.3 配置契约 ---

export interface PromptsConfig {
  system_prompt: string;
  extraction_prompt: string;
  state_injection_template: string;

  cold_start_template: string;
  memory_injection_template: string;
  memory_event_template: string;
  schedule_generation_prompt: string;
  /** 事件临近提示（隐形提示词，注入消息末尾，{{event}}/{{due_time}}） */
  event_reminder_template: string;
  /** 事件过期关心提示（隐形提示词，{{event}}/{{due_time}}） */
  event_care_template: string;
  /** AI 发心情动态的文案生成指令 */
  moment_generation_prompt: string;
  /** AI 在动态下评论/回评的文案生成指令 */
  moment_comment_prompt: string;
}

export interface DefaultPlaceholders {
  nickname: string;
  location: string;
  occupation: string;
  comm_preference: string;
}

export interface ThresholdsConfig {
  /** 每累计多少轮对话触发一次巩固提取 */
  consolidation_window_turns: number;
  /** 发送给模型的上下文轮数（与巩固触发频率解耦） */
  context_history_rounds: number;
  /** 记忆区加载的高权重事件数量 */
  context_active_events_limit: number;
  /** 详细/简略切换权重阈值：实时权重低于它的记忆只注入一句话 gist */
  detail_visible_weight: number;
  /** AI 主动评论用户动态的概率（0~1） */
  moment_ai_comment_probability: number;
  /** AI 回评/评论的随机延迟基准（毫秒，实际 ±50% 抖动） */
  moment_ai_reply_delay_ms: number;
  /** 发帖计划临场放弃的概率（0~1，真人偶尔想发又没发） */
  moment_post_skip_probability: number;
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

// --- 心情动态（朋友圈） ---

/** 心情标签固定集合（发帖选择与 LLM 输出都限定于此） */
export const MOOD_TAGS = ["开心", "平静", "低落", "烦躁", "期待"] as const;
export type MoodTag = (typeof MOOD_TAGS)[number];

/** 心情标签 → 柔和色点（卡片与发帖器共用） */
export const MOOD_COLORS: Record<MoodTag, string> = {
  开心: "#F5A623",
  平静: "#7A9EE6",
  低落: "#8A8FA3",
  烦躁: "#E07B5C",
  期待: "#7FB77E",
};

/** 动态作者 */
export type MomentAuthor = "user" | "ai";

/** 发帖计划执行状态 */
export type PostPlanStatus = "pending" | "posted" | "skipped";

/** 心情动态表 (moments) */
export interface Moment {
  id: number;
  author: MomentAuthor;
  /** 正文（纯文字，可含 emoji） */
  content: string;
  /** 心情标签，如「开心」「平静」「低落」 */
  mood: string;
  created_at: string;
}

/** 动态评论表 (moment_comments) */
export interface MomentComment {
  id: number;
  moment_id: number;
  author: MomentAuthor;
  content: string;
  created_at: string;
}

/** 周发帖计划行 (post_plan)：随作息表一起由 LLM 生成，允许某天不发 */
export interface PostPlanItem {
  id: number;
  week_start: string;
  /** 0=周一 … 6=周日 */
  day_of_week: number;
  /** 0=早(6-9) 1=上午(9-12) 2=午(12-15) 3=下午(15-18) 4=晚(18-23) */
  time_slot: number;
  /** 主题/心情提示，发帖时作为生成参考 */
  theme_hint: string;
  status: PostPlanStatus;
}

/** 发帖计划草稿（LLM 输出行，落库时补 week_start 与 status） */
export interface PostPlanDraft {
  day_of_week: number;
  time_slot: number;
  theme_hint: string;
}

// --- 聊天相关 ---

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  /** 思考内容（思考模式开启时） */
  thinking?: string;
  /** 属于哪一局游戏（有值则普通巩固流跳过，由游戏自己的巩固写入记忆） */
  game_id?: number;
  /** 游戏结束后合并出的摘要消息（替代整局对话，进上下文但不污染历史） */
  is_game_summary?: boolean;
}
