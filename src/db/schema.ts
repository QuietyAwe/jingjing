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
      emotion TEXT NOT NULL
    );

    -- 记忆事件表
    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "index" INTEGER NOT NULL,
      event_text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      active_weight INTEGER NOT NULL CHECK(active_weight BETWEEN 1 AND 100),
      last_accessed TEXT NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0
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
  `);
}
