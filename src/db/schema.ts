import { getDB } from "./connection";

/**
 * 初始化数据库表结构 — 对齐 PRD 4.1 节
 * App 启动时调用，幂等（CREATE IF NOT EXISTS）
 */
export function initSchema(): void {
  const db = getDB();

  db.execSync(`
    -- 记忆片段表
    CREATE TABLE IF NOT EXISTS memory_fragments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "index" INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      summary TEXT NOT NULL,
      emotion TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 5
    );

    -- 记忆事件表
    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "index" INTEGER NOT NULL,
      event_text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      active_weight INTEGER NOT NULL CHECK(active_weight BETWEEN 1 AND 100),
      last_accessed TEXT NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 5
    );

    CREATE INDEX IF NOT EXISTS idx_events_archive_weight
      ON memory_events(is_archived, active_weight);

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

    -- 行为时间表
    CREATE TABLE IF NOT EXISTS behavior_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      time_slot INTEGER NOT NULL,
      activity TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_week ON behavior_schedule(week_start);
  `);

  // 兼容旧表：添加 priority 字段（如果不存在）
  try {
    db.execSync(`ALTER TABLE memory_fragments ADD COLUMN priority INTEGER NOT NULL DEFAULT 5`);
  } catch {}
  try {
    db.execSync(`ALTER TABLE memory_events ADD COLUMN priority INTEGER NOT NULL DEFAULT 5`);
  } catch {}
}
