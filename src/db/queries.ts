import { getDB } from "./connection";
import type {
  SystemMetadata,
  UserInfo,
  MemoryEvent,
  MemoryFragment,
} from "@/types/schema";
import dayjs from "dayjs";

// ============================================================
// P2-1: system_metadata CRUD
// ============================================================

/** 读取系统元数据 */
export function getMeta(key: string): string | null {
  const db = getDB();
  const row = db.getFirstSync<SystemMetadata>(
    "SELECT value FROM system_metadata WHERE key = ?",
    key
  );
  return row?.value ?? null;
}

/** 写入系统元数据（upsert） */
export function setMeta(key: string, value: string): void {
  const db = getDB();
  db.runSync(
    'INSERT INTO system_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value
  );
}

// ============================================================
// P2-2: user_info 读写与增量 Merge
// ============================================================

/**
 * 读取用户信息
 * user_info 表按 key 分片存储顶层字段，此处重组为完整 UserInfo
 */
export function getUserInfo(): UserInfo | null {
  const db = getDB();
  const rows = db.getAllSync<SystemMetadata>(
    "SELECT key, value FROM user_info"
  );
  if (rows.length === 0) return null;

  const map = new Map<string, string>();
  for (const r of rows) map.set(r.key, r.value);

  const safeParse = <T>(key: string, fallback: T): T => {
    const raw = map.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };

  return {
    basic_identity: safeParse("basic_identity", {
      nickname: "",
      gender: "",
      birthday: "",
      occupation: "",
      location: "",
    }),
    preferences: safeParse("preferences", { likes: [], dislikes: [] }),
    social_graph: safeParse("social_graph", []),
    psycho_state: safeParse("psycho_state", {
      personality_traits: [],
      current_stressors: [],
      comm_preference: "",
    }),
    life_quests: safeParse("life_quests", {
      long_term_goals: [],
      ongoing_tasks: [],
    }),
  };
}

/** 更新 basic_identity.nickname（同步设置页称呼） */
export function updateBasicIdentityNickname(nickname: string): void {
  const db = getDB();
  const existing = getUserInfo();
  if (existing) {
    existing.basic_identity.nickname = nickname;
    db.runSync(
      'INSERT INTO user_info (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      "basic_identity",
      JSON.stringify(existing.basic_identity)
    );
  } else {
    // 首次：创建完整 user_info 骨架
    setUserInfo({
      basic_identity: { nickname, gender: "", birthday: "", occupation: "", location: "" },
      preferences: { likes: [], dislikes: [] },
      social_graph: [],
      psycho_state: { personality_traits: [], current_stressors: [], comm_preference: "" },
      life_quests: { long_term_goals: [], ongoing_tasks: [] },
    });
  }
}

/** 将完整 UserInfo 写入 user_info 表（全量覆盖各字段） */
export function setUserInfo(info: UserInfo): void {
  const db = getDB();
  const entries: [string, string][] = [
    ["basic_identity", JSON.stringify(info.basic_identity)],
    ["preferences", JSON.stringify(info.preferences)],
    ["social_graph", JSON.stringify(info.social_graph)],
    ["psycho_state", JSON.stringify(info.psycho_state)],
    ["life_quests", JSON.stringify(info.life_quests)],
  ];
  for (const [key, value] of entries) {
    db.runSync(
      'INSERT INTO user_info (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value
    );
  }
}

/**
 * 增量 Merge 用户信息 — 对齐 PRD 2.2 节第 4 步
 * 对数组字段执行值去重追加，非数组字段直接覆盖
 */
export function mergeUserInfo(patch: UserInfo): void {
  const existing = getUserInfo();
  if (!existing) {
    setUserInfo(patch);
    return;
  }

  // 数组去重追加 helper
  const mergeArray = (a: string[], b: string[]): string[] => {
    const set = new Set(a);
    for (const item of b) set.add(item);
    return Array.from(set);
  };

  // social_graph 按 name 去重
  const mergeSocialGraph = (
    a: UserInfo["social_graph"],
    b: UserInfo["social_graph"]
  ) => {
    const map = new Map(a.map((e) => [e.name, e]));
    for (const entry of b) map.set(entry.name, entry); // 新数据覆盖同名
    return Array.from(map.values());
  };

  // ongoing_tasks 按 task_name 去重，已完成/已取消的任务删除
  const mergeTasks = (
    a: UserInfo["life_quests"]["ongoing_tasks"],
    b: UserInfo["life_quests"]["ongoing_tasks"]
  ) => {
    const map = new Map(a.map((t) => [t.task_name, t]));
    for (const t of b) {
      if (t.status === "cancelled" || t.status === "completed") {
        // 已完成或已取消的任务从列表中删除
        map.delete(t.task_name);
      } else {
        map.set(t.task_name, t);
      }
    }
    return Array.from(map.values());
  };

  const merged: UserInfo = {
    basic_identity: { ...existing.basic_identity, ...patch.basic_identity },
    preferences: {
      likes: mergeArray(existing.preferences.likes, patch.preferences.likes),
      dislikes: mergeArray(
        existing.preferences.dislikes,
        patch.preferences.dislikes
      ),
    },
    social_graph: mergeSocialGraph(
      existing.social_graph,
      patch.social_graph
    ),
    psycho_state: {
      personality_traits: mergeArray(
        existing.psycho_state.personality_traits,
        patch.psycho_state.personality_traits
      ),
      current_stressors: mergeArray(
        existing.psycho_state.current_stressors,
        patch.psycho_state.current_stressors
      ),
      comm_preference:
        patch.psycho_state.comm_preference ||
        existing.psycho_state.comm_preference,
    },
    life_quests: {
      long_term_goals: mergeArray(
        existing.life_quests.long_term_goals,
        patch.life_quests.long_term_goals
      ),
      ongoing_tasks: mergeTasks(
        existing.life_quests.ongoing_tasks,
        patch.life_quests.ongoing_tasks
      ),
    },
  };

  setUserInfo(merged);
}

// ============================================================
// P2-3: memory_events CRUD
// ============================================================

/** 插入记忆事件，返回自增 ID */
export function insertEvent(
  eventText: string,
  activeWeight: number,
  index: number,
  priority: number = 5
): number {
  if (activeWeight < 1 || activeWeight > 100) {
    throw new Error("active_weight must be between 1 and 100");
  }
  if (priority < 1 || priority > 9) {
    throw new Error("priority must be between 1 and 9");
  }
  const db = getDB();
  const now = dayjs().toISOString();
  const result = db.runSync(
    'INSERT INTO memory_events ("index", event_text, timestamp, active_weight, last_accessed, is_archived, priority) VALUES (?, ?, ?, ?, ?, 0, ?)',
    index,
    eventText,
    now,
    activeWeight,
    now,
    priority
  );
  return Number(result.lastInsertRowId);
}

/** 获取 Top N 高权重活跃事件（实时衰减后排序） */
export function getTopActive(limit: number): MemoryEvent[] {
  const db = getDB();
  return db.getAllSync<MemoryEvent>(
    "SELECT * FROM memory_events WHERE is_archived = 0 ORDER BY active_weight DESC, last_accessed DESC LIMIT ?",
    limit
  );
}

/** 获取所有活跃事件（用于衰减计算） */
export function getAllActive(): MemoryEvent[] {
  const db = getDB();
  return db.getAllSync<MemoryEvent>(
    "SELECT * FROM memory_events WHERE is_archived = 0"
  );
}

/**
 * 随机抽取 1 条低权重冷记忆（灵光一闪） — 对齐 PRD 2.1 节第 5 步
 * @param excludeIds 排除的事件 ID（避免与 Top 10 重复）
 */
export function getEpiphanyRandom(excludeIds: number[] = []): MemoryEvent | null {
  const db = getDB();
  if (excludeIds.length === 0) {
    return db.getFirstSync<MemoryEvent>(
      "SELECT * FROM memory_events WHERE is_archived = 0 AND active_weight < 40 ORDER BY RANDOM() LIMIT 1"
    );
  }
  const placeholders = excludeIds.map(() => "?").join(",");
  return db.getFirstSync<MemoryEvent>(
    `SELECT * FROM memory_events WHERE is_archived = 0 AND active_weight < 40 AND id NOT IN (${placeholders}) ORDER BY RANDOM() LIMIT 1`,
    ...excludeIds
  );
}

/** 更新事件权重与访问时间 */
export function updateWeight(eventId: number, weight: number): void {
  const db = getDB();
  const now = dayjs().toISOString();
  db.runSync(
    "UPDATE memory_events SET active_weight = ?, last_accessed = ? WHERE id = ?",
    weight,
    now,
    eventId
  );
}

/** 更新事件优先级（取最大值） */
export function updateEventPriority(eventId: number, priority: number): void {
  const db = getDB();
  db.runSync(
    "UPDATE memory_events SET priority = MAX(priority, ?) WHERE id = ?",
    priority,
    eventId
  );
}

/** 软归档事件 */
export function softArchive(eventId: number): void {
  const db = getDB();
  db.runSync(
    "UPDATE memory_events SET is_archived = 1 WHERE id = ?",
    eventId
  );
}

/** 获取所有活跃事件数量 */
export function getActiveCount(): number {
  const db = getDB();
  const row = db.getFirstSync<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM memory_events WHERE is_archived = 0"
  );
  return row?.cnt ?? 0;
}

/** 获取权重最低的 N 条冷事件（做梦流用） */
export function getColdestEvents(limit: number): MemoryEvent[] {
  const db = getDB();
  return db.getAllSync<MemoryEvent>(
    "SELECT * FROM memory_events WHERE is_archived = 0 ORDER BY active_weight ASC, last_accessed ASC LIMIT ?",
    limit
  );
}

/** 批量软归档 */
export function softArchiveBatch(eventIds: number[]): void {
  const db = getDB();
  for (const id of eventIds) {
    db.runSync(
      "UPDATE memory_events SET is_archived = 1 WHERE id = ?",
      id
    );
  }
}

/** 更新事件文本 */
export function updateEventText(eventId: number, newText: string): void {
  const db = getDB();
  db.runSync(
    "UPDATE memory_events SET event_text = ? WHERE id = ?",
    newText,
    eventId
  );
}

/** 硬删除事件及其关联片段 */
export function deleteEvent(eventId: number): void {
  const db = getDB();
  db.runSync('DELETE FROM memory_fragments WHERE "index" = ?', eventId);
  db.runSync("DELETE FROM memory_events WHERE id = ?", eventId);
}

// ============================================================
// P2-4: memory_fragments CRUD
// ============================================================

/** 插入记忆片段 */
export function insertFragment(
  eventIndex: number,
  summary: string,
  emotion: string,
  priority: number = 5
): number {
  if (priority < 1 || priority > 9) {
    throw new Error("priority must be between 1 and 9");
  }
  const db = getDB();
  const now = dayjs().toISOString();
  const result = db.runSync(
    'INSERT INTO memory_fragments ("index", timestamp, summary, emotion, priority) VALUES (?, ?, ?, ?, ?)',
    eventIndex,
    now,
    summary,
    emotion,
    priority
  );
  return Number(result.lastInsertRowId);
}

/** 按事件 ID 查询关联的记忆片段 */
export function getFragmentsByEventId(eventId: number): MemoryFragment[] {
  const db = getDB();
  return db.getAllSync<MemoryFragment>(
    'SELECT * FROM memory_fragments WHERE "index" = ? ORDER BY timestamp ASC',
    eventId
  );
}

/** 获取最新一条记忆片段的 emotion（用于状态区注入） */
export function getLatestEmotion(): string | null {
  const db = getDB();
  const row = db.getFirstSync<MemoryFragment>(
    "SELECT emotion FROM memory_fragments ORDER BY timestamp DESC LIMIT 1"
  );
  return row?.emotion ?? null;
}

/** 清除所有数据（四张表），用于设置页重置 */
export function clearAllData(): void {
  const db = getDB();
  db.runSync("DELETE FROM memory_fragments");
  db.runSync("DELETE FROM memory_events");
  db.runSync("DELETE FROM user_info");
  db.runSync("DELETE FROM system_metadata");
}
