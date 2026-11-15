import { getDB } from "./connection";
import dayjs from "dayjs";

/** memory_events 的标准列（所有 SELECT 都必须用它，不要用 SELECT *） */
export const EVENT_COLUMNS =
  "id, event_text, timestamp, active_weight, last_accessed, priority, memory_kind, event_status, closed_at, nudge_count";

/**
 * 初始化数据库表结构 — 对齐 PRD 4.1 节
 * App 启动时调用，幂等（CREATE IF NOT EXISTS）
 */
export function initSchema(): void {
  const db = getDB();

  db.execSync(`
    -- 记忆片段表（"index" 为父事件 id）
    CREATE TABLE IF NOT EXISTS memory_fragments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "index" INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      gist TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 5
    );

    -- 记忆事件表
    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      active_weight INTEGER NOT NULL CHECK(active_weight BETWEEN 1 AND 100),
      last_accessed TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 5,
      memory_kind TEXT NOT NULL DEFAULT 'daily',
      event_status TEXT NOT NULL DEFAULT 'none',
      closed_at TEXT,
      nudge_count INTEGER NOT NULL DEFAULT 0
    );

    -- 游戏会话表
    CREATE TABLE IF NOT EXISTS game_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_type TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      secret TEXT NOT NULL DEFAULT '',
      secret_source TEXT NOT NULL DEFAULT 'public',
      question_count INTEGER NOT NULL DEFAULT 0,
      turns TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      result_note TEXT
    );

    -- 系统元数据表
    CREATE TABLE IF NOT EXISTS system_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 用户信息表
    CREATE TABLE IF NOT EXISTS user_info (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- AI 行为时间表（AI 自己的作息，非用户作息）
    CREATE TABLE IF NOT EXISTS behavior_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      time_slot INTEGER NOT NULL,
      activity TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- 心情动态表（用户 / AI / AI 熟人圈好友发帖，类朋友圈）
    CREATE TABLE IF NOT EXISTS moments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT NOT NULL CHECK(author IN ('user','ai','friend')),
      content TEXT NOT NULL,
      mood TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      friend_id INTEGER
    );

    -- 动态评论表
    CREATE TABLE IF NOT EXISTS moment_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      moment_id INTEGER NOT NULL,
      author TEXT NOT NULL CHECK(author IN ('user','ai','friend')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      friend_id INTEGER
    );

    -- 周发帖计划（AI 随作息表生成；好友按日掷骰后插入，author/friend_id 区分归属）
    CREATE TABLE IF NOT EXISTS post_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      time_slot INTEGER NOT NULL,
      theme_hint TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','posted','skipped')),
      created_at TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'ai',
      friend_id INTEGER
    );

    -- 每日实况（周表是习惯，这张表是今天具体怎么过的）
    CREATE TABLE IF NOT EXISTS daily_log (
      day TEXT PRIMARY KEY,
      slots TEXT NOT NULL DEFAULT '',
      mood TEXT NOT NULL DEFAULT '',
      highlight TEXT NOT NULL DEFAULT '',
      late_night TEXT NOT NULL DEFAULT '',
      weather TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- AI 的熟人圈（不是用户的社交图谱，两个桶不混用）
    CREATE TABLE IF NOT EXISTS friend_personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      avatar_emoji TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      profile TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      debut_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_week ON behavior_schedule(week_start);
    CREATE INDEX IF NOT EXISTS idx_moments_created ON moments(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_moment ON moment_comments(moment_id);
    CREATE INDEX IF NOT EXISTS idx_post_plan_week ON post_plan(week_start);
    CREATE INDEX IF NOT EXISTS idx_fragments_index ON memory_fragments("index");
    CREATE INDEX IF NOT EXISTS idx_events_weight ON memory_events(active_weight DESC);

    -- 事件别名：合并过的标题/关键词记在这里，下次新事件命中别名直接挂靠，
    -- 同一个「是不是同一段经历」的判断不重复做
    CREATE TABLE IF NOT EXISTS memory_event_aliases (
      event_id INTEGER NOT NULL,
      alias TEXT NOT NULL,
      PRIMARY KEY (event_id, alias)
    );
    CREATE INDEX IF NOT EXISTS idx_event_aliases_alias ON memory_event_aliases(alias);

    -- AI 检索判定记录：每轮判定的原始输出与结果，供复盘与反哺标注集
    CREATE TABLE IF NOT EXISTS retrieval_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      user_text TEXT NOT NULL,
      stage1_output TEXT,
      stage2_output TEXT,
      final_injected TEXT NOT NULL DEFAULT '',
      fallback INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      expand_used INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_retrieval_logs_created ON retrieval_logs(created_at DESC);
  `);

  // 建表语句对已存在的表不生效：本版新增的列在这里补一次（幂等）
  try {
    db.execSync(`ALTER TABLE memory_events ADD COLUMN closed_at TEXT`);
  } catch {}
  try {
    db.execSync(`ALTER TABLE memory_events ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0`);
  } catch {}

  // 初始化默认事件"日常闲聊"（用于兜底，减少垃圾信息）
  initDefaultEvent(db);
}

/**
 * 初始化默认事件"日常闲聊"
 * 用于巩固流兜底：没有提取到有价值信息时，挂靠到此事件
 * 不参与检索，避免污染搜索结果
 */
function initDefaultEvent(db: ReturnType<typeof getDB>): void {
  const existing = db.getFirstSync<{ value: string }>(
    "SELECT value FROM system_metadata WHERE key = 'default_event_id'"
  );

  if (existing) return; // 已存在，跳过

  // 创建默认事件
  const now = dayjs().toISOString();
  const result = db.runSync(
    "INSERT INTO memory_events (event_text, timestamp, active_weight, last_accessed, priority, memory_kind) VALUES (?, ?, 50, ?, 1, 'daily')",
    "日常闲聊",
    now,
    now
  );

  // 存储默认事件 ID 到元数据
  const eventId = Number(result.lastInsertRowId);
  db.runSync(
    'INSERT INTO system_metadata (key, value) VALUES (?, ?)',
    "default_event_id",
    String(eventId)
  );
}
