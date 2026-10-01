import { getDB } from "./connection";
import { EVENT_COLUMNS } from "./schema";
import type {
  SystemMetadata,
  UserInfo,
  MemoryEvent,
  MemoryFragment,
  ConsolidationResponse,
  MemoryKind,
  GameSession,
  GameTurn,
  GameStatus,
  GameMode,
  GameType,
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

/** 获取默认事件"日常闲聊"的 ID */
export function getDefaultEventId(): number | null {
  const db = getDB();
  const row = db.getFirstSync<SystemMetadata>(
    "SELECT value FROM system_metadata WHERE key = 'default_event_id'"
  );
  return row ? parseInt(row.value, 10) : null;
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
 * patch 可以是 Partial，缺失字段保持原值
 */
export function mergeUserInfo(patch: ConsolidationResponse["new_info"]): void {
  const existing = getUserInfo();
  if (!existing) {
    // 首次：用 patch 填充，缺失字段用空值
    const empty: UserInfo = {
      basic_identity: { nickname: "", gender: "", birthday: "", occupation: "", location: "" },
      preferences: { likes: [], dislikes: [] },
      social_graph: [],
      psycho_state: { personality_traits: [], current_stressors: [], comm_preference: "" },
      life_quests: { long_term_goals: [], ongoing_tasks: [] },
    };
    setUserInfo(mergeUserInfoDelta(empty, patch));
    return;
  }
  setUserInfo(mergeUserInfoDelta(existing, patch));
}

/** 合并 delta 到 existing（纯函数，不写 DB） */
function mergeUserInfoDelta(existing: UserInfo, patch: ConsolidationResponse["new_info"]): UserInfo {
  const mergeArray = (a: string[], b?: string[]) => {
    if (!b || b.length === 0) return a;
    const set = new Set(a);
    for (const item of b) set.add(item);
    return Array.from(set);
  };

  const mergeSocialGraph = (a: UserInfo["social_graph"], b?: UserInfo["social_graph"]) => {
    if (!b || b.length === 0) return a;
    const map = new Map(a.map((e) => [e.name, e]));
    for (const entry of b) map.set(entry.name, entry);
    return Array.from(map.values());
  };

  const mergeTasks = (
    a: UserInfo["life_quests"]["ongoing_tasks"],
    b?: UserInfo["life_quests"]["ongoing_tasks"],
  ) => {
    if (!b || b.length === 0) return a;
    const map = new Map(a.map((t) => [t.task_name, t]));
    for (const t of b) {
      if (t.status === "cancelled" || t.status === "completed") {
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
      likes: mergeArray(existing.preferences.likes, patch.preferences?.likes),
      dislikes: mergeArray(existing.preferences.dislikes, patch.preferences?.dislikes),
    },
    social_graph: mergeSocialGraph(existing.social_graph, patch.social_graph),
    psycho_state: {
      personality_traits: mergeArray(existing.psycho_state.personality_traits, patch.psycho_state?.personality_traits),
      current_stressors: mergeArray(existing.psycho_state.current_stressors, patch.psycho_state?.current_stressors),
      comm_preference: patch.psycho_state?.comm_preference || existing.psycho_state.comm_preference,
    },
    life_quests: {
      long_term_goals: mergeArray(existing.life_quests.long_term_goals, patch.life_quests?.long_term_goals),
      ongoing_tasks: mergeTasks(existing.life_quests.ongoing_tasks, patch.life_quests?.ongoing_tasks),
    },
  };

  return merged;
}

// ============================================================
// P2-3: memory_events CRUD
// ============================================================

/** 插入记忆事件，返回自增 ID */
export function insertEvent(
  eventText: string,
  activeWeight: number,
  priority: number = 5,
  kind: MemoryKind = "daily"
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
    "INSERT INTO memory_events (event_text, timestamp, active_weight, last_accessed, priority, memory_kind) VALUES (?, ?, ?, ?, ?, ?)",
    eventText,
    now,
    activeWeight,
    now,
    priority,
    kind
  );
  return Number(result.lastInsertRowId);
}

/**
 * 写入一条共同经历（episode）记忆
 *
 * 同名事件只建一次，之后追加片段——「一起玩20问」是一个事件，
 * 每次对局是它下面的一个片段，这与真人记忆一致（记得玩过很多次，每次是不同片段）。
 */
export function insertEpisode(
  eventText: string,
  summary: string,
  emotion: string,
  priority: number = 7
): number {
  const clamped = Math.min(9, Math.max(1, priority));
  const existing = findEpisodeEvent(eventText);
  if (existing) {
    insertFragment(existing.id, summary, emotion, clamped);
    // 刷新为最近一次，回到清晰状态
    updateWeight(existing.id, 100);
    return existing.id;
  }
  const eventId = insertEvent(eventText, 100, clamped, "episode");
  insertFragment(eventId, summary, emotion, clamped);
  return eventId;
}

/** 按文本查找 episode 事件 */
function findEpisodeEvent(eventText: string): MemoryEvent | null {
  const db = getDB();
  return (
    db.getFirstSync<MemoryEvent>(
      `SELECT ${EVENT_COLUMNS} FROM memory_events WHERE memory_kind = 'episode' AND event_text = ? ORDER BY id ASC LIMIT 1`,
      eventText
    ) ?? null
  );
}

/**
 * 合并同名 episode 事件（自愈历史数据）
 * 用于早期版本每次对局新建事件留下的重复项，幂等。
 */
export function mergeEpisodeDuplicates(): void {
  const db = getDB();
  const dupes = db.getAllSync<{ event_text: string; ids: string }>(
    `SELECT event_text, GROUP_CONCAT(id) AS ids
     FROM memory_events WHERE memory_kind = 'episode'
     GROUP BY event_text HAVING COUNT(*) > 1`
  );
  if (dupes.length === 0) return;

  const now = dayjs().toISOString();
  for (const row of dupes) {
    const ids = row.ids.split(",").map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
    if (ids.length < 2) continue;
    const keep = Math.min(...ids);
    for (const id of ids) {
      if (id === keep) continue;
      db.runSync('UPDATE memory_fragments SET "index" = ? WHERE "index" = ?', keep, id);
      db.runSync("DELETE FROM memory_events WHERE id = ?", id);
    }
    db.runSync(
      "UPDATE memory_events SET active_weight = 100, last_accessed = ? WHERE id = ?",
      now,
      keep
    );
  }
}

/** 根据 ID 获取单个事件 */
export function getEventById(eventId: number): MemoryEvent | null {
  const db = getDB();
  return db.getFirstSync<MemoryEvent>(
    `SELECT ${EVENT_COLUMNS} FROM memory_events WHERE id = ?`,
    eventId
  );
}

/** 获取 Top N 高权重活跃事件（排除默认事件） */
export function getTopActive(limit: number): MemoryEvent[] {
  const db = getDB();
  const defaultEventId = getDefaultEventId();
  const excludeDefault = defaultEventId ? `AND id != ${defaultEventId}` : "";
  return db.getAllSync<MemoryEvent>(
    `SELECT ${EVENT_COLUMNS} FROM memory_events WHERE 1 = 1 ${excludeDefault} ORDER BY active_weight DESC, last_accessed DESC LIMIT ?`,
    limit
  );
}

/** 获取所有活跃事件（用于衰减计算，排除默认事件） */
export function getAllActive(): MemoryEvent[] {
  const db = getDB();
  const defaultEventId = getDefaultEventId();
  const excludeDefault = defaultEventId ? `AND id != ${defaultEventId}` : "";
  return db.getAllSync<MemoryEvent>(
    `SELECT ${EVENT_COLUMNS} FROM memory_events WHERE 1 = 1 ${excludeDefault}`
  );
}

/**
 * 随机抽取 1 条低权重冷记忆（灵光一闪） — 对齐 PRD 2.1 节第 5 步
 * @param excludeIds 排除的事件 ID（避免与 Top 10 重复）
 */
export function getEpiphanyRandom(excludeIds: number[] = []): MemoryEvent | null {
  const db = getDB();
  const defaultEventId = getDefaultEventId();
  // 默认事件也加入排除列表
  const allExcludeIds = defaultEventId ? [...excludeIds, defaultEventId] : excludeIds;
  if (allExcludeIds.length === 0) {
    return db.getFirstSync<MemoryEvent>(
      `SELECT ${EVENT_COLUMNS} FROM memory_events WHERE active_weight < 40 ORDER BY RANDOM() LIMIT 1`
    );
  }
  const placeholders = allExcludeIds.map(() => "?").join(",");
  return db.getFirstSync<MemoryEvent>(
    `SELECT ${EVENT_COLUMNS} FROM memory_events WHERE active_weight < 40 AND id NOT IN (${placeholders}) ORDER BY RANDOM() LIMIT 1`,
    ...allExcludeIds
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

/** 获取活跃事件数量（排除默认事件） */
export function getActiveCount(): number {
  const db = getDB();
  const defaultEventId = getDefaultEventId();
  const excludeDefault = defaultEventId ? `AND id != ${defaultEventId}` : "";
  const row = db.getFirstSync<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM memory_events WHERE 1 = 1 ${excludeDefault}`
  );
  return row?.cnt ?? 0;
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
    'SELECT id, "index", timestamp, summary, emotion, priority FROM memory_fragments WHERE "index" = ? ORDER BY timestamp ASC',
    eventId
  );
}

/**
 * 批量查询多个事件的记忆片段（一次 IN 查询，避免 N+1）
 * @returns eventId → 该事件的片段列表（按时间升序）
 */
export function getFragmentsByEventIds(eventIds: number[]): Map<number, MemoryFragment[]> {
  const result = new Map<number, MemoryFragment[]>();
  if (eventIds.length === 0) return result;

  const db = getDB();
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db.getAllSync<MemoryFragment>(
    `SELECT id, "index", timestamp, summary, emotion, priority FROM memory_fragments WHERE "index" IN (${placeholders}) ORDER BY timestamp ASC`,
    ...eventIds
  );
  for (const row of rows) {
    const list = result.get(row.index);
    if (list) list.push(row);
    else result.set(row.index, [row]);
  }
  return result;
}

/** 删除单条记忆片段 */
export function deleteFragment(fragmentId: number): void {
  const db = getDB();
  db.runSync("DELETE FROM memory_fragments WHERE id = ?", fragmentId);
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
  db.runSync("DELETE FROM behavior_schedule");

  // 重新初始化默认事件"日常闲聊"
  const now = dayjs().toISOString();
  const result = db.runSync(
    "INSERT INTO memory_events (event_text, timestamp, active_weight, last_accessed, priority) VALUES (?, ?, 50, ?, 1)",
    "日常闲聊",
    now,
    now
  );
  const eventId = Number(result.lastInsertRowId);
  db.runSync(
    'INSERT INTO system_metadata (key, value) VALUES (?, ?)',
    "default_event_id",
    String(eventId)
  );
}

// ============================================================
// 游戏会话 CRUD
// ============================================================

/** 创建新对局，返回会话 ID */
export function createGameSession(params: {
  gameType: GameType;
  mode: GameMode;
  secret: string;
  secretSource: "memory" | "public";
}): number {
  const db = getDB();
  const now = dayjs().toISOString();
  const result = db.runSync(
    `INSERT INTO game_sessions (game_type, mode, status, secret, secret_source, question_count, turns, started_at)
     VALUES (?, ?, 'playing', ?, ?, 0, '[]', ?)`,
    params.gameType,
    params.mode,
    params.secret,
    params.secretSource,
    now
  );
  return Number(result.lastInsertRowId);
}

/** 取当前进行中的对局 */
export function getActiveGameSession(): GameSession | null {
  const db = getDB();
  return (
    db.getFirstSync<GameSession>(
      "SELECT * FROM game_sessions WHERE status = 'playing' ORDER BY id DESC LIMIT 1"
    ) ?? null
  );
}

/** 取最近一局（用于题材去重） */
export function getRecentSecrets(limit: number = 20): string[] {
  const db = getDB();
  const rows = db.getAllSync<{ secret: string }>(
    "SELECT secret FROM game_sessions WHERE secret != '' ORDER BY id DESC LIMIT ?",
    limit
  );
  return rows.map((r) => r.secret).filter(Boolean);
}

/** 追加一回合流水；传入 countDelta 表示是否计一次提问 */
export function appendGameTurn(
  sessionId: number,
  turn: GameTurn,
  countDelta: number
): GameSession | null {
  const db = getDB();
  const session = db.getFirstSync<GameSession>(
    "SELECT * FROM game_sessions WHERE id = ?",
    sessionId
  );
  if (!session) return null;

  let turns: GameTurn[] = [];
  try {
    turns = JSON.parse(session.turns) as GameTurn[];
  } catch {
    turns = [];
  }
  turns.push(turn);

  db.runSync(
    "UPDATE game_sessions SET turns = ?, question_count = question_count + ? WHERE id = ?",
    JSON.stringify(turns),
    countDelta,
    sessionId
  );
  return getGameSessionById(sessionId);
}

export function getGameSessionById(sessionId: number): GameSession | null {
  const db = getDB();
  return (
    db.getFirstSync<GameSession>(
      "SELECT * FROM game_sessions WHERE id = ?",
      sessionId
    ) ?? null
  );
}

/** 结束对局 */
export function finishGameSession(
  sessionId: number,
  status: GameStatus,
  resultNote: string
): void {
  const db = getDB();
  db.runSync(
    "UPDATE game_sessions SET status = ?, ended_at = ?, result_note = ? WHERE id = ?",
    status,
    dayjs().toISOString(),
    resultNote,
    sessionId
  );
}

/**
 * 覆盖式更新流水（快艇这类状态整体存储的对局用）
 */
export function updateGameTurns(sessionId: number, turnsJson: string): void {
  const db = getDB();
  db.runSync(
    "UPDATE game_sessions SET turns = ? WHERE id = ?",
    turnsJson,
    sessionId
  );
}

/** 解析流水 JSON */
export function parseGameTurns(session: GameSession): GameTurn[] {
  try {
    return JSON.parse(session.turns) as GameTurn[];
  } catch {
    return [];
  }
}

// ============================================================
// 行为时间表 CRUD
// ============================================================

export interface ScheduleItem {
  day_of_week: number;  // 0=周一, 6=周日
  time_slot: number;    // 0=早, 1=上午, 2=午, 3=下午, 4=晚
  activity: string;
}

/** 删除指定周的时间表 */
export function deleteScheduleForWeek(weekStart: string): void {
  const db = getDB();
  db.runSync("DELETE FROM behavior_schedule WHERE week_start = ?", weekStart);
}

/** 检查本周是否已有时间表 */
export function hasScheduleForWeek(weekStart: string): boolean {
  const db = getDB();
  const row = db.getFirstSync<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM behavior_schedule WHERE week_start = ?",
    weekStart
  );
  return (row?.cnt ?? 0) > 0;
}

/** 获取整周时间表 */
export function getWeekSchedule(weekStart: string): ScheduleItem[] {
  const db = getDB();
  return db.getAllSync<ScheduleItem>(
    "SELECT day_of_week, time_slot, activity FROM behavior_schedule WHERE week_start = ? ORDER BY day_of_week, time_slot",
    weekStart
  );
}

/** 获取当前时段的活动 */
export function getCurrentActivity(dayOfWeek: number, timeSlot: number, weekStart: string): string | null {
  const db = getDB();
  const row = db.getFirstSync<{ activity: string }>(
    "SELECT activity FROM behavior_schedule WHERE week_start = ? AND day_of_week = ? AND time_slot = ?",
    weekStart,
    dayOfWeek,
    timeSlot
  );
  return row?.activity ?? null;
}

/** 获取今天已结束的活动（当前时段之前的） */
export function getEndedActivities(dayOfWeek: number, timeSlot: number, weekStart: string): string[] {
  const db = getDB();
  const rows = db.getAllSync<{ activity: string }>(
    "SELECT activity FROM behavior_schedule WHERE week_start = ? AND day_of_week = ? AND time_slot < ? ORDER BY time_slot",
    weekStart,
    dayOfWeek,
    timeSlot
  );
  return rows.map(r => r.activity);
}

/** 批量插入时间表 */
export function insertSchedule(weekStart: string, items: ScheduleItem[]): void {
  const db = getDB();
  const now = dayjs().toISOString();
  for (const item of items) {
    db.runSync(
      "INSERT INTO behavior_schedule (week_start, day_of_week, time_slot, activity, created_at) VALUES (?, ?, ?, ?, ?)",
      weekStart,
      item.day_of_week,
      item.time_slot,
      item.activity,
      now
    );
  }
}
