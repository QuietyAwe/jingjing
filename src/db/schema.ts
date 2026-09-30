import { getDB } from "./connection";
import dayjs from "dayjs";

/** memory_events 的标准列（不含历史遗留的 "index" 与已废弃的 is_archived） */
export const EVENT_COLUMNS =
  "id, event_text, timestamp, active_weight, last_accessed, priority";

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
      summary TEXT NOT NULL,
      emotion TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 5
    );

    -- 记忆事件表
    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      active_weight INTEGER NOT NULL CHECK(active_weight BETWEEN 1 AND 100),
      last_accessed TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 5
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

    CREATE INDEX IF NOT EXISTS idx_schedule_week ON behavior_schedule(week_start);
    CREATE INDEX IF NOT EXISTS idx_fragments_index ON memory_fragments("index");
    CREATE INDEX IF NOT EXISTS idx_events_weight ON memory_events(active_weight DESC);
  `);

  // 兼容旧表 + 清理已废弃列
  migrateLegacyColumns(db);

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
    "INSERT INTO memory_events (event_text, timestamp, active_weight, last_accessed, priority) VALUES (?, ?, 50, ?, 1)",
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
