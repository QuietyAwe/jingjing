import { getDB } from "./connection";
import dayjs from "dayjs";

/** memory_events 的标准列（不含历史遗留的 "index" 与已废弃的 is_archived） */
export const EVENT_COLUMNS =
  "id, event_text, timestamp, active_weight, last_accessed, priority, memory_kind";

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
      memory_kind TEXT NOT NULL DEFAULT 'daily'
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
  `);

  // 兼容旧表 + 清理已废弃列
  migrateLegacyColumns(db);

  // 好友圈/日实况相关的结构迁移（moments 的 CHECK 约束只能靠重建表扩展）
  migrateSocialSchema(db);

  // 表重建会连带删掉索引，这里统一补回（幂等）
  db.execSync(`
    CREATE INDEX IF NOT EXISTS idx_moments_created ON moments(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_moment ON moment_comments(moment_id);
    CREATE INDEX IF NOT EXISTS idx_post_plan_week ON post_plan(week_start);
    CREATE INDEX IF NOT EXISTS idx_moments_friend ON moments(friend_id);
  `);

  // 初始化默认事件"日常闲聊"（用于兜底，减少垃圾信息）
  initDefaultEvent(db);
}

/** 读取表的现有列名 */
function getColumns(db: ReturnType<typeof getDB>, table: string): string[] {
  const rows = db.getAllSync<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

/**
 * 迁移旧表结构
 * - priority 为后加字段，旧库可能缺失
 * - memory_events."index" 与 is_archived 均已废弃（做梦流下线后无写入方）
 *   做梦流删除后 is_archived 恒为 0，"index" 全仓无读取点，两者一并清除
 */
function migrateLegacyColumns(db: ReturnType<typeof getDB>): void {
  // 1. 补 priority 字段
  try {
    db.execSync(`ALTER TABLE memory_fragments ADD COLUMN priority INTEGER NOT NULL DEFAULT 5`);
  } catch {}
  try {
    db.execSync(`ALTER TABLE memory_events ADD COLUMN priority INTEGER NOT NULL DEFAULT 5`);
  } catch {}
  try {
    db.execSync(`ALTER TABLE memory_events ADD COLUMN memory_kind TEXT NOT NULL DEFAULT 'daily'`);
  } catch {}

  const eventCols = getColumns(db, "memory_events");

  // 2. 删除归档索引后才能删列
  if (eventCols.includes("is_archived")) {
    try {
      db.execSync(`DROP INDEX IF EXISTS idx_events_archive_weight`);
    } catch {}
    try {
      db.execSync(`ALTER TABLE memory_events DROP COLUMN is_archived`);
    } catch {}
  }

  // 3. 删除无用的 "index" 列（SQLite 3.35+ 支持 DROP COLUMN，失败则保持旧结构，
  //    所有 SELECT 均使用显式列名，不会因旧列残留而报错）
  const colsAfterArchive = getColumns(db, "memory_events");
  if (colsAfterArchive.includes("index")) {
    try {
      db.execSync(`ALTER TABLE memory_events DROP COLUMN "index"`);
    } catch {}
  }

  // 4. 补 gist 列（记忆分层：一句话概要，低活跃度时只保留这一句）
  try {
    db.execSync(`ALTER TABLE memory_fragments ADD COLUMN gist TEXT NOT NULL DEFAULT ''`);
  } catch {}

  // 5. 补 keywords 列（写入时抽取的关键词索引，含同义表达，供检索匹配）
  try {
    db.execSync(`ALTER TABLE memory_fragments ADD COLUMN keywords TEXT NOT NULL DEFAULT ''`);
  } catch {}

  // 6. emotion 列下线：它只写不读（从未进入 Prompt，getLatestEmotion 也无调用方），
  //    情绪改由 summary 一并承载。删列前先把老内容并进 summary，避免丢信息
  if (getColumns(db, "memory_fragments").includes("emotion")) {
    try {
      db.execSync(
        `UPDATE memory_fragments
         SET summary = summary || '（' || emotion || '）'
         WHERE emotion IS NOT NULL AND TRIM(emotion) <> ''`
      );
    } catch {}
    try {
      db.execSync(`ALTER TABLE memory_fragments DROP COLUMN emotion`);
    } catch {}
  }
}

/** 读取建表 SQL（用于判断 CHECK 约束/列是否已更新） */
function getTableSql(db: ReturnType<typeof getDB>, table: string): string {
  const row = db.getFirstSync<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    table
  );
  return row?.sql ?? "";
}

/**
 * 好友圈 / 日实况的结构迁移
 *
 * `moments.author` 与 `moment_comments.author` 原本带 `CHECK(author IN ('user','ai'))`，
 * SQLite 无法直接修改 CHECK，只能重建表。用「新建 → 拷贝 → 删旧 → 改名」的顺序，
 * 中途失败时旧表仍在，不会丢数据。
 */
function migrateSocialSchema(db: ReturnType<typeof getDB>): void {
  // 1. moments
  const momentsSql = getTableSql(db, "moments");
  if (momentsSql && (!momentsSql.includes("friend_id") || !momentsSql.includes("'friend'"))) {
    try {
      db.execSync(`
        CREATE TABLE moments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          author TEXT NOT NULL CHECK(author IN ('user','ai','friend')),
          content TEXT NOT NULL,
          mood TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          friend_id INTEGER
        );
        INSERT INTO moments_new (id, author, content, mood, created_at, friend_id)
          SELECT id, author, content, mood, created_at, NULL FROM moments;
        DROP TABLE moments;
        ALTER TABLE moments_new RENAME TO moments;
      `);
    } catch {}
  }

  // 2. moment_comments
  const commentsSql = getTableSql(db, "moment_comments");
  if (commentsSql && (!commentsSql.includes("friend_id") || !commentsSql.includes("'friend'"))) {
    try {
      db.execSync(`
        CREATE TABLE moment_comments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          moment_id INTEGER NOT NULL,
          author TEXT NOT NULL CHECK(author IN ('user','ai','friend')),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          friend_id INTEGER
        );
        INSERT INTO moment_comments_new (id, moment_id, author, content, created_at, friend_id)
          SELECT id, moment_id, author, content, created_at, NULL FROM moment_comments;
        DROP TABLE moment_comments;
        ALTER TABLE moment_comments_new RENAME TO moment_comments;
      `);
    } catch {}
  }

  // 3. post_plan 归属列（后加字段，旧库缺失）
  try {
    db.execSync(`ALTER TABLE post_plan ADD COLUMN author TEXT NOT NULL DEFAULT 'ai'`);
  } catch {}
  try {
    db.execSync(`ALTER TABLE post_plan ADD COLUMN friend_id INTEGER`);
  } catch {}

  // 4. 好友删除标记（删除只让人消失，不洗记忆；历史动态还要显示名字）
  try {
    db.execSync(`ALTER TABLE friend_personas ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`);
  } catch {}
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
