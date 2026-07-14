import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";

const DB_NAME = "jingjing.db";

let db: SQLiteDatabase | null = null;

/** 获取 SQLite 连接单例 */
export function getDB(): SQLiteDatabase {
  if (!db) {
    db = openDatabaseSync(DB_NAME);
  }
  return db;
}
