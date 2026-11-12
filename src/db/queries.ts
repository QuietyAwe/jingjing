import { getDB } from "./connection";
import { EVENT_COLUMNS } from "./schema";
import { bigrams } from "@/memory/tokenize";
import {
  EVENT_USER_MOMENT,
  EVENT_AI_MOMENT,
  EVENT_FRIEND_FEED,
  MOMENT_EVENT_ALIASES,
} from "@/moments/events";
import type {
  SystemMetadata,
  UserInfo,
  StateItem,
  AppointmentStatus,
  MemoryEvent,
  MemoryFragment,
  ConsolidationResponse,
  MemoryKind,
  GameSession,
  GameTurn,
  GameStatus,
  GameMode,
  GameType,
  Moment,
  MomentAuthor,
  MomentComment,
  PostPlanItem,
  PostPlanDraft,
  PostPlanStatus,
  FriendPersona,
  DailyLog,
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
// P2-2: user_info 读写与增量 Merge（属性/状态 两桶；未来事件存在 memory_events）
// ============================================================

/** 状态注入有效期：超过这么多天未再被提及即停止注入（数据保留） */
export const STATE_EXPIRE_DAYS = 7;

/** 事件关心里：过期后注入关心提示的窗口（小时），满窗自动归档 */
export const EVENT_CARE_WINDOW_HOURS = 48;

/** 空画像骨架 */
function emptyProfile(): UserInfo {
  return {
    basic_identity: { nickname: "", gender: "", birthday: "", occupation: "", location: "" },
    social_graph: [],
    traits: [],
    states: [],
  };
}

/** 仍注入状态区的活跃状态（超 STATE_EXPIRE_DAYS 未提及的不注入，数据保留） */
export function activeStates(userInfo: UserInfo, now?: dayjs.Dayjs): StateItem[] {
  const cutoff = (now ?? dayjs()).subtract(STATE_EXPIRE_DAYS, "day");
  return userInfo.states.filter((s) => dayjs(s.created_at).isAfter(cutoff));
}

/**
 * 未归档的未来事件（upcoming + caring），按发生时刻排序
 *
 * 不只是约定：离职、考试、手术、搬家这类未来节点同样存在这张表里
 * （timestamp 就是它发生的时刻），靠 event_status 区分生命周期，到点由时间通道注入提醒。
 */
export function getUpcomingEvents(): MemoryEvent[] {
  const db = getDB();
  return db.getAllSync<MemoryEvent>(
    `SELECT ${EVENT_COLUMNS} FROM memory_events
     WHERE event_status IN ('upcoming', 'caring')
     ORDER BY timestamp ASC`
  );
}

/** 推进约定状态（upcoming → caring → archived） */
export function updateEventStatus(eventId: number, status: AppointmentStatus): void {
  const db = getDB();
  db.runSync("UPDATE memory_events SET event_status = ? WHERE id = ?", status, eventId);
}

/**
 * 写入 / 更新一条未来事件（约定、安排、重大节点都算）
 *
 * 同一件事被重复提取时只更新时刻与状态，不新建事件。
 * `timestamp` 就是它发生的时刻，`event_status` 由时刻决定：未到 → upcoming，已过 → caring。
 */
export function upsertFutureEvent(text: string, happensAt: string, priority: number = 5): number {
  const db = getDB();
  const existing = db.getFirstSync<MemoryEvent>(
    `SELECT ${EVENT_COLUMNS} FROM memory_events
     WHERE event_status != 'none' AND event_text = ?
     ORDER BY id DESC LIMIT 1`,
    text
  );
  const status: AppointmentStatus = dayjs(happensAt).isAfter(dayjs()) ? "upcoming" : "caring";
  if (existing) {
    db.runSync(
      "UPDATE memory_events SET timestamp = ?, event_status = ?, priority = MAX(priority, ?), last_accessed = ? WHERE id = ?",
      happensAt,
      status,
      priority,
      dayjs().toISOString(),
      existing.id
    );
    return existing.id;
  }
  return insertEvent(text, 100, priority, "episode", happensAt, status);
}

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

  // 旧版（五块）画像一次性迁移成两桶：preferences/psycho_state/life_quests 拆进 traits/states。
  // 存量约定不迁移：约定已并入 memory_events，旧的 events 键读到时直接丢弃。
  const legacyKeys = ["preferences", "psycho_state", "life_quests"].filter((k) => map.has(k));
  if (legacyKeys.length > 0 && !map.has("traits")) {
    const traits: string[] = [];
    const states: StateItem[] = [];
    const nowIso = dayjs().toISOString();

    const prefs = safeParse("preferences", { likes: [] as string[], dislikes: [] as string[] });
    for (const x of prefs.likes) if (x?.trim()) traits.push(`喜欢${x.trim()}`);
    for (const x of prefs.dislikes) if (x?.trim()) traits.push(`讨厌${x.trim()}`);

    const ps = safeParse("psycho_state", {
      personality_traits: [] as string[],
      current_stressors: [] as string[],
      comm_preference: "",
    });
    for (const x of ps.personality_traits) if (x?.trim()) traits.push(x.trim());
    if (ps.comm_preference?.trim()) traits.push(`沟通偏好：${ps.comm_preference.trim()}`);
    for (const x of ps.current_stressors) if (x?.trim()) states.push({ text: x.trim(), created_at: nowIso });

    const lq = safeParse("life_quests", {
      long_term_goals: [] as string[],
      ongoing_tasks: [] as Array<{ task_name: string; due_time?: string }>,
    });
    for (const x of lq.long_term_goals) if (x?.trim()) traits.push(`长期目标：${x.trim()}`);
    for (const t of lq.ongoing_tasks) {
      const text = t.task_name?.trim();
      if (text) states.push({ text, created_at: nowIso });
    }

    for (const [k, v] of [["traits", traits], ["states", states]] as const) {
      const value = JSON.stringify(v);
      db.runSync(
        'INSERT INTO user_info (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        k,
        value
      );
      map.set(k, value);
    }
  }
  // 旧键残留直接删（恢复旧备份会再带进来，上面的迁移分支会重新处理）
  for (const k of legacyKeys) {
    db.runSync("DELETE FROM user_info WHERE key = ?", k);
    map.delete(k);
  }

  return {
    basic_identity: safeParse("basic_identity", emptyProfile().basic_identity),
    social_graph: safeParse("social_graph", []),
    traits: safeParse("traits", []),
    states: safeParse("states", []),
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
    const profile = emptyProfile();
    profile.basic_identity.nickname = nickname;
    setUserInfo(profile);
  }
}

/** 将完整 UserInfo 写入 user_info 表（全量覆盖各字段） */
export function setUserInfo(info: UserInfo): void {
  const db = getDB();
  const entries: [string, string][] = [
    ["basic_identity", JSON.stringify(info.basic_identity)],
    ["social_graph", JSON.stringify(info.social_graph)],
    ["traits", JSON.stringify(info.traits)],
    ["states", JSON.stringify(info.states)],
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
 * @param asOf 本次信息实际发生的时刻（分批消化时沿用历史对话时间）；缺省为当前时间
 */
export function mergeUserInfo(patch: ConsolidationResponse["new_info"], asOf?: string): void {
  const nowIso = asOf ?? dayjs().toISOString();
  const existing = getUserInfo() ?? emptyProfile();
  setUserInfo(mergeUserInfoDelta(existing, patch, nowIso));
}

/** 合并 delta 到 existing（纯函数，不写 DB） */
function mergeUserInfoDelta(
  existing: UserInfo,
  patch: ConsolidationResponse["new_info"],
  nowIso: string
): UserInfo {
  /**
   * 数组合并 + 去重 + 上限。
   *
   * 上限是必要的：这些数组只增不减（合并是「Set 追加」），
   * 不设上限会无限膨胀。截取策略是「保留最新追加的 N 条」。
   *
   * 注意：Set.add / Map.set 对已存在的键**不改变插入位置**，
   * 直接写会让「刚被重提刷新」的旧条目留在队首、被 slice(-cap) 当最旧裁掉。
   * 所以重提前一律先 delete 再写，把条目挪到队尾。
   */
  const mergeArray = (a: string[], b: string[] | undefined, cap: number) => {
    const set = new Set(a);
    for (const item of b ?? []) {
      const t = item?.trim();
      if (!t) continue;
      set.delete(t);
      set.add(t);
    }
    const merged = Array.from(set);
    return merged.length > cap ? merged.slice(-cap) : merged;
  };

  const mergeSocialGraph = (a: UserInfo["social_graph"], b?: UserInfo["social_graph"]) => {
    if (!b || b.length === 0) return a;
    const map = new Map(a.map((e) => [e.name, e]));
    for (const entry of b) {
      map.delete(entry.name);
      map.set(entry.name, entry);
    }
    return Array.from(map.values()).slice(-30);
  };

  // 状态：同一文本再次提及 = 刷新时效（回到活跃区）
  const mergeStates = (a: StateItem[], b: string[] | undefined): StateItem[] => {
    if (!b || b.length === 0) return a;
    const map = new Map(a.map((s) => [s.text, s]));
    for (const raw of b) {
      const text = raw?.trim();
      if (!text) continue;
      map.delete(text);
      map.set(text, { text, created_at: nowIso });
    }
    return Array.from(map.values()).slice(-20);
  };

  const merged: UserInfo = {
    basic_identity: { ...existing.basic_identity, ...patch.basic_identity },
    social_graph: mergeSocialGraph(existing.social_graph, patch.social_graph),
    traits: mergeArray(existing.traits, patch.traits, 30),
    states: mergeStates(existing.states, patch.states),
  };

  return merged;
}

// ============================================================
// P2-3: memory_events CRUD
// ============================================================

/**
 * 插入记忆事件，返回自增 ID
 * @param timestamp 事件实际发生时间（分批消化时沿用历史对话时间）；缺省为当前时间。
 *                 只影响 [time] 渲染与排序，last_accessed 仍写创建时刻——衰减从「记下时」起算，行为不变
 */
export function insertEvent(
  eventText: string,
  activeWeight: number,
  priority: number = 5,
  kind: MemoryKind = "daily",
  timestamp?: string,
  appointmentStatus: AppointmentStatus = "none"
): number {
  if (activeWeight < 1 || activeWeight > 100) {
    throw new Error("active_weight must be between 1 and 100");
  }
  if (priority < 1 || priority > 9) {
    throw new Error("priority must be between 1 and 9");
  }
  const db = getDB();
  const now = dayjs().toISOString();
  const ts = timestamp ?? now;
  const result = db.runSync(
    "INSERT INTO memory_events (event_text, timestamp, active_weight, last_accessed, priority, memory_kind, event_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    eventText,
    ts,
    activeWeight,
    now,
    priority,
    kind,
    appointmentStatus
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
  gist: string,
  summary: string,
  priority: number = 7,
  keywords: string = ""
): number {
  const clamped = Math.min(9, Math.max(1, priority));
  const existing = findEpisodeEvent(eventText);
  if (existing) {
    insertFragment(existing.id, gist, summary, clamped, keywords);
    // 刷新为最近一次，回到清晰状态
    updateWeight(existing.id, 100);
    return existing.id;
  }
  const eventId = insertEvent(eventText, 100, clamped, "episode");
  insertFragment(eventId, gist, summary, clamped, keywords);
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
 * 找语义重复的已有事件（B10）
 *
 * 靠 bigram 重合度判断「一起玩游戏」和「玩游戏」是不是同一件事，
 * 避免 LLM 每次换个说法就新建一个事件、事件表持续膨胀
 * （而事件表一膨胀，检索候选和记忆区 Top N 的质量都会下降）。
 *
 * @param text 候选事件标题
 * @param excludeId 排除的事件 ID（合并时排除自己）
 * @returns 最相似的已有事件；相似度不足返回 null
 */
export function findSimilarEvent(text: string, excludeId?: number): MemoryEvent | null {
  const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");
  const target = norm(text);
  if (target.length < 2) return null;

  const db = getDB();
  // 约定事件（未来才发生）不参与「普通记忆新建时」的相似合并：
  // 把一条已发生的片段挂到「周五面试」这种约定上，检索时会出现时间错乱
  const rows = db.getAllSync<MemoryEvent>(
    `SELECT ${EVENT_COLUMNS} FROM memory_events WHERE memory_kind != 'daily' AND event_status = 'none'`
  );
  const targetBigrams = new Set(bigrams(target));

  let best: { event: MemoryEvent; score: number } | null = null;
  for (const row of rows) {
    if (excludeId !== undefined && row.id === excludeId) continue;
    const candidate = norm(row.event_text);
    if (candidate.length < 2) continue;

    // 互相包含（短的那个是长的的子串）= 同一件事，直接判最高分
    let score: number;
    if (target.includes(candidate) || candidate.includes(target)) {
      score = 1;
    } else {
      const setB = new Set(bigrams(candidate));
      let common = 0;
      for (const g of targetBigrams) if (setB.has(g)) common++;
      // 用较小集合的覆盖率做归一化，短标题之间也能量化相似度
      score = common / Math.min(targetBigrams.size, setB.size);
    }
    if (score >= 0.5 && (!best || score > best.score)) best = { event: row, score };
  }
  return best?.event ?? null;
}

/** 别名归一化：去掉空白与标点，「双十一，纠结」和「双十一纠结」算同一条 */
function normalizeAlias(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").trim();
}

/** 写入事件别名（重复忽略） */
export function addEventAliases(eventId: number, aliases: string[]): void {
  const db = getDB();
  for (const raw of aliases) {
    const alias = normalizeAlias(raw);
    if (!alias) continue;
    db.runSync(
      "INSERT OR IGNORE INTO memory_event_aliases (event_id, alias) VALUES (?, ?)",
      eventId,
      alias
    );
  }
}

/**
 * 批量取事件的别名文本（合并过的旧标题），供检索打分用
 *
 * 只命中别名的事件如果仍用 event_text 打分，会被「重合度 > 0」过滤掉，
 * 所以检索侧必须把别名拼进打分文本。
 */
export function getEventAliasText(eventIds: number[]): Map<number, string> {
  const map = new Map<number, string>();
  if (eventIds.length === 0) return map;
  const db = getDB();
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db.getAllSync<{ event_id: number; aliases: string }>(
    `SELECT event_id, GROUP_CONCAT(alias, ' ') AS aliases
     FROM memory_event_aliases
     WHERE event_id IN (${placeholders})
     GROUP BY event_id`,
    ...eventIds
  );
  for (const row of rows) map.set(row.event_id, row.aliases ?? "");
  return map;
}

/** 按别名查事件：合并过的标题再次出现时直接挂靠，不再重复判断 */
export function getEventByAlias(alias: string): MemoryEvent | null {
  const norm = normalizeAlias(alias);
  if (!norm) return null;
  const db = getDB();
  const row = db.getFirstSync<{ event_id: number }>(
    "SELECT event_id FROM memory_event_aliases WHERE alias = ? LIMIT 1",
    norm
  );
  return row ? getEventById(row.event_id) : null;
}

/**
 * 合并事件（在巩固事务内调用）
 *
 * 片段改挂 keep；被并事件的标题与别名转给 keep；priority/weight 取大、timestamp 取早。
 * 别名冲突（两个事件有同名别名）直接跳过，不能中断整次巩固。
 */
export function mergeEvents(keepId: number, mergeIds: number[], extraAliases: string[] = []): void {
  const db = getDB();
  const keep = getEventById(keepId);
  if (!keep) return;

  const targets = mergeIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0 && id !== keepId && !!getEventById(id));
  if (targets.length === 0) {
    if (extraAliases.length > 0) addEventAliases(keepId, extraAliases);
    return;
  }

  const aliases = [...extraAliases];
  // 约定状态取「更靠后」的：upcoming > caring > none > archived
  const statusRank: Record<AppointmentStatus, number> = {
    upcoming: 3,
    caring: 2,
    none: 1,
    archived: 0,
  };
  let priority = keep.priority;
  let earliest = keep.timestamp;
  let latest = keep.timestamp;
  let weight = keep.active_weight;
  let status: AppointmentStatus = keep.event_status ?? "none";
  for (const id of targets) {
    const e = getEventById(id)!;
    aliases.push(e.event_text);
    priority = Math.max(priority, e.priority);
    if (e.timestamp < earliest) earliest = e.timestamp;
    if (e.timestamp > latest) latest = e.timestamp;
    weight = Math.max(weight, e.active_weight);
    const s = e.event_status ?? "none";
    if (statusRank[s] > statusRank[status]) status = s;
  }
  // 约定取更晚的时刻（最近安排的那个），普通记忆取更早（事情实际发生的时间）
  const timestamp = status === "upcoming" ? latest : earliest;

  const inClause = targets.map(() => "?").join(",");
  db.runSync(
    `UPDATE memory_fragments SET "index" = ? WHERE "index" IN (${inClause})`,
    keepId,
    ...targets
  );
  for (const id of targets) {
    db.runSync(
      "UPDATE OR IGNORE memory_event_aliases SET event_id = ? WHERE event_id = ?",
      keepId,
      id
    );
    db.runSync("DELETE FROM memory_event_aliases WHERE event_id = ?", id);
    db.runSync("DELETE FROM memory_events WHERE id = ?", id);
  }

  db.runSync(
    "UPDATE memory_events SET priority = ?, timestamp = ?, active_weight = ?, last_accessed = ?, event_status = ? WHERE id = ?",
    priority,
    timestamp,
    weight,
    dayjs().toISOString(),
    status,
    keepId
  );
  addEventAliases(keepId, aliases);
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

/**
 * 自愈历史数据：旧版把动态互动单独记成「和[user]在动态下的互动」事件，
 * 现在互动片段并入帖子作者对应的事件（见 moments/events.ts）。
 * 这里把片段改挂过去、删掉旧事件，幂等。
 */
export function mergeLegacyMomentInteractionEvent(): void {
  const LEGACY_EVENT = "和[user]在动态下的互动";
  const db = getDB();
  const legacy = db.getFirstSync<{ id: number }>(
    "SELECT id FROM memory_events WHERE event_text = ?",
    LEGACY_EVENT
  );
  if (!legacy) return;

  const target = db.getFirstSync<{ id: number }>(
    "SELECT id FROM memory_events WHERE event_text = ?",
    EVENT_USER_MOMENT
  );
  if (!target) {
    // 目标事件还不存在：直接改名，片段不用动
    db.runSync(
      "UPDATE memory_events SET event_text = ? WHERE id = ?",
      EVENT_USER_MOMENT,
      legacy.id
    );
    return;
  }

  db.runSync('UPDATE memory_fragments SET "index" = ? WHERE "index" = ?', target.id, legacy.id);
  db.runSync(
    "UPDATE OR IGNORE memory_event_aliases SET event_id = ? WHERE event_id = ?",
    target.id,
    legacy.id
  );
  db.runSync("DELETE FROM memory_event_aliases WHERE event_id = ?", legacy.id);
  db.runSync("DELETE FROM memory_events WHERE id = ?", legacy.id);
}

/**
 * 自愈历史数据：给已存在的动态事件补口语别名（别名机制上线前的库没有）。
 * 幂等。
 */
export function ensureMomentEventAliases(): void {
  const db = getDB();
  const rows = db.getAllSync<{ id: number }>(
    "SELECT id FROM memory_events WHERE event_text IN (?, ?, ?)",
    EVENT_USER_MOMENT,
    EVENT_AI_MOMENT,
    EVENT_FRIEND_FEED
  );
  for (const row of rows) addEventAliases(row.id, MOMENT_EVENT_ALIASES);
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

/**
 * 关键词倒排取候选事件（巩固流用）
 *
 * 三个来源：片段内容、事件标题、别名（合并过的旧标题）。
 * 只靠片段会把「标题说得很准、但片段里没出现这个词」的事件漏掉，
 * 只靠标题又会漏掉「片段在延续、标题措辞不同」的事件。
 * 命中不足时用最近被想起的事件补齐；默认事件不参与倒排，由调用方决定是否兜底追加。
 */
export function getCandidateEvents(keywords: string[], limit: number = 5): MemoryEvent[] {
  const db = getDB();
  const defaultEventId = getDefaultEventId();
  const excludeDefault = defaultEventId ? `AND e.id != ${defaultEventId}` : "";
  const picked: MemoryEvent[] = [];
  const seen = new Set<number>();

  if (keywords.length > 0) {
    const fragConds = keywords
      .map(() => "(f.summary LIKE ? OR f.gist LIKE ? OR f.keywords LIKE ?)")
      .join(" OR ");
    const titleConds = keywords.map(() => "e.event_text LIKE ?").join(" OR ");
    const aliasConds = keywords
      .map(
        () =>
          "EXISTS(SELECT 1 FROM memory_event_aliases a WHERE a.event_id = e.id AND a.alias LIKE ?)"
      )
      .join(" OR ");
    // 参数顺序必须与 SQL 中出现顺序一致：JOIN ON（片段）→ WHERE（标题、别名）→ LIMIT
    const params = [
      ...keywords.flatMap((k) => [`%${k}%`, `%${k}%`, `%${k}%`]),
      ...keywords.map((k) => `%${k}%`),
      ...keywords.map((k) => `%${k}%`),
    ];

    const rows = db.getAllSync<MemoryEvent>(
      `SELECT ${EVENT_COLUMNS.split(", ")
        .map((c) => `e.${c}`)
        .join(", ")}, COUNT(f.id) AS hits
       FROM memory_events e
       LEFT JOIN memory_fragments f
         ON f."index" = e.id
        AND LENGTH(f.summary) >= 10
        AND (${fragConds})
       WHERE 1 = 1 ${excludeDefault}
         AND (f.id IS NOT NULL OR (${titleConds}) OR (${aliasConds}))
       GROUP BY e.id
       ORDER BY hits DESC, e.last_accessed DESC
       LIMIT ?`,
      ...params,
      limit
    );
    for (const e of rows) {
      picked.push(e);
      seen.add(e.id);
    }
  }

  if (picked.length < limit) {
    for (const e of getTopActive(limit)) {
      if (picked.length >= limit) break;
      if (seen.has(e.id)) continue;
      picked.push(e);
      seen.add(e.id);
    }
  }
  return picked;
}

/**
 * 获取所有活跃事件（用于衰减计算，排除默认事件）
 *
 * 排除 upcoming 约定：还没发生的事不是「回忆」，由状态区的「安排」和时间通道负责，
 * 混进氛围记忆会让记忆区出现「明天才考试」这种未来时间的记忆行。
 */
export function getAllActive(): MemoryEvent[] {
  const db = getDB();
  const defaultEventId = getDefaultEventId();
  const excludeDefault = defaultEventId ? `AND id != ${defaultEventId}` : "";
  return db.getAllSync<MemoryEvent>(
    `SELECT ${EVENT_COLUMNS} FROM memory_events WHERE 1 = 1 ${excludeDefault} AND event_status != 'upcoming'`
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

/** 硬删除事件及其关联片段与别名（别名不删会挂到复用 id 的新事件上） */
export function deleteEvent(eventId: number): void {
  const db = getDB();
  db.runSync('DELETE FROM memory_fragments WHERE "index" = ?', eventId);
  db.runSync("DELETE FROM memory_event_aliases WHERE event_id = ?", eventId);
  db.runSync("DELETE FROM memory_events WHERE id = ?", eventId);
}

// ============================================================
// P2-4: memory_fragments CRUD
// ============================================================

/**
 * 插入记忆片段
 * @param timestamp 片段实际发生时间（分批消化时沿用历史对话时间）；缺省为当前时间
 */
export function insertFragment(
  eventIndex: number,
  gist: string,
  summary: string,
  priority: number = 5,
  keywords: string = "",
  timestamp?: string
): number {
  if (priority < 1 || priority > 9) {
    throw new Error("priority must be between 1 and 9");
  }
  const db = getDB();
  const ts = timestamp ?? dayjs().toISOString();
  const result = db.runSync(
    'INSERT INTO memory_fragments ("index", timestamp, gist, summary, keywords, priority) VALUES (?, ?, ?, ?, ?, ?)',
    eventIndex,
    ts,
    gist,
    summary,
    keywords,
    priority
  );
  return Number(result.lastInsertRowId);
}

/** 按事件 ID 查询关联的记忆片段 */
export function getFragmentsByEventId(eventId: number): MemoryFragment[] {
  const db = getDB();
  return db.getAllSync<MemoryFragment>(
    'SELECT id, "index", timestamp, gist, summary, keywords, priority FROM memory_fragments WHERE "index" = ? ORDER BY timestamp ASC',
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
    `SELECT id, "index", timestamp, gist, summary, keywords, priority FROM memory_fragments WHERE "index" IN (${placeholders}) ORDER BY timestamp ASC`,
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

/** 清除所有数据（含心情动态三表），用于设置页重置 */
export function clearAllData(): void {
  const db = getDB();
  db.runSync("DELETE FROM memory_fragments");
  // 别名指向 memory_events.id：清空事件后必须一起清，否则 id 复用会让旧别名挂到新事件上
  db.runSync("DELETE FROM memory_event_aliases");
  db.runSync("DELETE FROM memory_events");
  db.runSync("DELETE FROM game_sessions");
  db.runSync("DELETE FROM user_info");
  db.runSync("DELETE FROM system_metadata");
  db.runSync("DELETE FROM behavior_schedule");
  db.runSync("DELETE FROM moment_comments");
  db.runSync("DELETE FROM moments");
  db.runSync("DELETE FROM post_plan");
  db.runSync("DELETE FROM daily_log");
  db.runSync("DELETE FROM friend_personas");

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

/** 取最近一局（用于题材去重）。只取 20问的谜底——数字炸弹的 secret 是炸弹数字，混进来会污染去重列表 */
export function getRecentSecrets(limit: number = 20): string[] {
  const db = getDB();
  const rows = db.getAllSync<{ secret: string }>(
    "SELECT secret FROM game_sessions WHERE game_type = 'twenty_questions' AND secret != '' ORDER BY id DESC LIMIT ?",
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

  let turns: GameTurn[];
  try {
    const parsed = JSON.parse(session.turns);
    // turns 只应是 20问的 GameTurn[] 流水；其他游戏类型在此存的是状态对象，
    // 误路由进来时必须拒绝写入，否则 push 抛 TypeError 或覆盖掉对局状态
    if (!Array.isArray(parsed)) return null;
    turns = parsed as GameTurn[];
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

/**
 * 更新对局小结（游戏结束后用于上下文摘要，
 * 复用记忆提取的内容，避免游戏对话污染上下文）
 */
export function updateGameResultNote(sessionId: number, note: string): void {
  const db = getDB();
  db.runSync(
    "UPDATE game_sessions SET result_note = ? WHERE id = ?",
    note,
    sessionId
  );
}

/** 整局删除：移除对局记录（配合删除该局全部聊天消息） */
export function deleteGameSession(sessionId: number): void {
  const db = getDB();
  db.runSync("DELETE FROM game_sessions WHERE id = ?", sessionId);
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
 * 标记对局已结束（只更新状态，不动 result_note）。
 * 用于「写好 result_note 后才补记状态」的场景（如快艇 writeYachtMemory 已写 note）。
 * 状态一旦不是 playing，getHistory 就会把该局合并成一条游戏回顾摘要。
 */
export function markGameEnded(sessionId: number, status: GameStatus): void {
  const db = getDB();
  db.runSync(
    "UPDATE game_sessions SET status = ?, ended_at = ? WHERE id = ?",
    status,
    dayjs().toISOString(),
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

// ============================================================
// 心情动态 CRUD（moments / moment_comments / post_plan）
// ============================================================

/** 发布一条动态，返回自增 ID（好友发帖传 friendId） */
export function insertMoment(
  author: MomentAuthor,
  content: string,
  mood: string,
  friendId?: number | null
): number {
  const db = getDB();
  const result = db.runSync(
    "INSERT INTO moments (author, content, mood, created_at, friend_id) VALUES (?, ?, ?, ?, ?)",
    author,
    content,
    mood,
    dayjs().toISOString(),
    friendId ?? null
  );
  return Number(result.lastInsertRowId);
}

/**
 * 分页获取动态（时间倒序）
 * @param limit 每页条数
 * @param beforeId 只取该 ID 之前的更早动态（游标分页，不含自身）
 */
export function getMoments(limit: number, beforeId?: number): Moment[] {
  const db = getDB();
  if (beforeId !== undefined) {
    return db.getAllSync<Moment>(
      "SELECT id, author, content, mood, created_at, friend_id FROM moments WHERE id < ? ORDER BY id DESC LIMIT ?",
      beforeId,
      limit
    );
  }
  return db.getAllSync<Moment>(
    "SELECT id, author, content, mood, created_at, friend_id FROM moments ORDER BY id DESC LIMIT ?",
    limit
  );
}

/** 最近一段时间内发布过的动态作者（灵光一闪新近度加权用） */
export function getRecentMomentAuthors(sinceIso: string): MomentAuthor[] {
  const db = getDB();
  return db
    .getAllSync<{ author: MomentAuthor }>(
      "SELECT author FROM moments WHERE created_at >= ? ORDER BY id DESC",
      sinceIso
    )
    .map((r) => r.author);
}

/** 最近被用户评论过的动态作者（同一帖子多轮评论只算一次） */
export function getRecentUserCommentedMomentAuthors(sinceIso: string): MomentAuthor[] {
  const db = getDB();
  return db
    .getAllSync<{ author: MomentAuthor }>(
      `SELECT DISTINCT m.author AS author
       FROM moment_comments c
       JOIN moments m ON m.id = c.moment_id
       WHERE c.author = 'user' AND c.created_at >= ?`,
      sinceIso
    )
    .map((r) => r.author);
}

/** 按 ID 批量取动态（用户刚浏览过的帖子 → 灵光一闪加权） */
export function getMomentsByIds(ids: number[]): Moment[] {
  if (ids.length === 0) return [];
  const db = getDB();
  const placeholders = ids.map(() => "?").join(",");
  return db.getAllSync<Moment>(
    `SELECT id, author, content, mood, created_at, friend_id FROM moments WHERE id IN (${placeholders})`,
    ...ids
  );
}

/** 按 ID 获取单条动态 */
export function getMomentById(momentId: number): Moment | null {
  const db = getDB();
  return (
    db.getFirstSync<Moment>(
      "SELECT id, author, content, mood, created_at, friend_id FROM moments WHERE id = ?",
      momentId
    ) ?? null
  );
}

/** 追加一条评论，返回自增 ID（好友评论传 friendId） */
export function insertMomentComment(
  momentId: number,
  author: MomentAuthor,
  content: string,
  friendId?: number | null
): number {
  const db = getDB();
  const result = db.runSync(
    "INSERT INTO moment_comments (moment_id, author, content, created_at, friend_id) VALUES (?, ?, ?, ?, ?)",
    momentId,
    author,
    content,
    dayjs().toISOString(),
    friendId ?? null
  );
  return Number(result.lastInsertRowId);
}

/** 按动态 ID 查询评论（时间升序） */
export function getMomentComments(momentId: number): MomentComment[] {
  const db = getDB();
  return db.getAllSync<MomentComment>(
    "SELECT id, moment_id, author, content, created_at, friend_id FROM moment_comments WHERE moment_id = ? ORDER BY id ASC",
    momentId
  );
}

/** 批量查询多条动态的评论（一次 IN 查询，避免 N+1） */
export function getCommentsByMomentIds(momentIds: number[]): Map<number, MomentComment[]> {
  const result = new Map<number, MomentComment[]>();
  if (momentIds.length === 0) return result;

  const db = getDB();
  const placeholders = momentIds.map(() => "?").join(",");
  const rows = db.getAllSync<MomentComment>(
    `SELECT id, moment_id, author, content, created_at, friend_id FROM moment_comments WHERE moment_id IN (${placeholders}) ORDER BY id ASC`,
    ...momentIds
  );
  for (const row of rows) {
    const list = result.get(row.moment_id);
    if (list) list.push(row);
    else result.set(row.moment_id, [row]);
  }
  return result;
}

/** 获取某条动态的最新一条 AI 评论（用于判断互动是否已闭环） */
export function getLatestAiComment(momentId: number): MomentComment | null {
  const db = getDB();
  return (
    db.getFirstSync<MomentComment>(
      "SELECT id, moment_id, author, content, created_at, friend_id FROM moment_comments WHERE moment_id = ? AND author = 'ai' ORDER BY id DESC LIMIT 1",
      momentId
    ) ?? null
  );
}

/** 删除动态及其评论 */
export function deleteMoment(momentId: number): void {
  const db = getDB();
  db.runSync("DELETE FROM moment_comments WHERE moment_id = ?", momentId);
  db.runSync("DELETE FROM moments WHERE id = ?", momentId);
}

// --- 周发帖计划 ---

/** 删除指定周的发帖计划 */
export function deletePostPlanForWeek(weekStart: string): void {
  const db = getDB();
  db.runSync("DELETE FROM post_plan WHERE week_start = ?", weekStart);
}

/**
 * 检查本周是否已有 AI 的发帖计划（好友计划另算：它们按天掷骰插入，
 * 不能用来证明「主角这周的计划已经生成过」）
 */
export function hasPostPlanForWeek(weekStart: string): boolean {
  const db = getDB();
  const row = db.getFirstSync<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM post_plan WHERE week_start = ? AND author = 'ai'",
    weekStart
  );
  return (row?.cnt ?? 0) > 0;
}

/** 批量插入发帖计划（status 一律 pending） */
export function insertPostPlan(weekStart: string, items: PostPlanDraft[]): void {
  const db = getDB();
  const now = dayjs().toISOString();
  for (const item of items) {
    db.runSync(
      "INSERT INTO post_plan (week_start, day_of_week, time_slot, theme_hint, status, created_at, author, friend_id) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
      weekStart,
      item.day_of_week,
      item.time_slot,
      item.theme_hint,
      now,
      item.author ?? "ai",
      item.friend_id ?? null
    );
  }
}

/** 获取指定周的全部发帖计划 */
export function getPostPlanForWeek(weekStart: string): PostPlanItem[] {
  const db = getDB();
  return db.getAllSync<PostPlanItem>(
    "SELECT id, week_start, day_of_week, time_slot, theme_hint, status, author, friend_id FROM post_plan WHERE week_start = ? ORDER BY day_of_week, time_slot",
    weekStart
  );
}

/**
 * 获取某天某时段待执行的发帖计划
 * @param author 'ai'（默认）只取主角色的计划，好友计划由调用方单独取
 */
export function getPendingPlanForSlot(
  weekStart: string,
  dayOfWeek: number,
  timeSlot: number,
  author: "ai" | "friend" = "ai"
): PostPlanItem[] {
  const db = getDB();
  return db.getAllSync<PostPlanItem>(
    "SELECT id, week_start, day_of_week, time_slot, theme_hint, status, author, friend_id FROM post_plan WHERE week_start = ? AND day_of_week = ? AND time_slot = ? AND status = 'pending' AND author = ?",
    weekStart,
    dayOfWeek,
    timeSlot,
    author
  );
}

/** 某位好友在指定周某天是否已经有发帖计划（含已发/已跳过，用于每日只掷一次骰） */
export function hasFriendPlanOnDay(weekStart: string, dayOfWeek: number, friendId: number): boolean {
  const db = getDB();
  const row = db.getFirstSync<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM post_plan WHERE week_start = ? AND day_of_week = ? AND author = 'friend' AND friend_id = ?",
    weekStart,
    dayOfWeek,
    friendId
  );
  return (row?.cnt ?? 0) > 0;
}

/**
 * 跳过已错过时段的待执行计划（不补发，模仿真人）。
 * 只处理「今天更早的时段」与「本周更早的日子」，返回被跳过的行数。
 */
export function skipMissedPostPlans(weekStart: string, dayOfWeek: number, timeSlot: number): number {
  const db = getDB();
  const result = db.runSync(
    `UPDATE post_plan SET status = 'skipped'
     WHERE week_start = ? AND status = 'pending'
       AND (day_of_week < ? OR (day_of_week = ? AND time_slot < ?))`,
    weekStart,
    dayOfWeek,
    dayOfWeek,
    timeSlot
  );
  return result.changes;
}

/** 更新发帖计划状态（pending|posted|skipped） */
export function updatePostPlanStatus(planId: number, status: PostPlanStatus): void {
  const db = getDB();
  db.runSync("UPDATE post_plan SET status = ? WHERE id = ?", status, planId);
}

// ============================================================
// 每日实况 CRUD（daily_log）
// ============================================================

/** 读取某天的实况 */
export function getDailyLog(day: string): DailyLog | null {
  const db = getDB();
  return (
    db.getFirstSync<DailyLog>("SELECT * FROM daily_log WHERE day = ?", day) ?? null
  );
}

/**
 * 写入/补齐某天的实况字段（只覆盖传入的字段）
 * 深夜状态可能在白天生成之前就先落库，所以必须支持部分更新
 */
export function upsertDailyLog(
  day: string,
  patch: Partial<Omit<DailyLog, "day" | "created_at" | "updated_at">>
): void {
  const db = getDB();
  const now = dayjs().toISOString();
  const existing = getDailyLog(day);
  if (!existing) {
    db.runSync(
      "INSERT INTO daily_log (day, slots, mood, highlight, late_night, weather, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      day,
      patch.slots ?? "",
      patch.mood ?? "",
      patch.highlight ?? "",
      patch.late_night ?? "",
      patch.weather ?? "",
      now,
      now
    );
    return;
  }
  db.runSync(
    `UPDATE daily_log SET
       slots = ?, mood = ?, highlight = ?, late_night = ?, weather = ?, updated_at = ?
     WHERE day = ?`,
    patch.slots ?? existing.slots,
    patch.mood ?? existing.mood,
    patch.highlight ?? existing.highlight,
    patch.late_night ?? existing.late_night,
    patch.weather ?? existing.weather,
    now,
    day
  );
}

/** 最近 N 天（不含今天）的实况，按日期升序 */
export function getRecentDailyLogs(days: number, beforeDay: string): DailyLog[] {
  const db = getDB();
  return db.getAllSync<DailyLog>(
    "SELECT * FROM daily_log WHERE day < ? ORDER BY day DESC LIMIT ?",
    beforeDay,
    days
  ).reverse();
}

// ============================================================
// 好友档案 CRUD（friend_personas）
// ============================================================

/**
 * 全部好友（含停用/已删除），用于设置页管理与历史动态署名。
 * 已删除的人必须还留在这里：ta 发过的动态要能显示名字（关系记忆不洗）。
 */
export function getAllFriends(): FriendPersona[] {
  const db = getDB();
  return db.getAllSync<FriendPersona>(
    "SELECT * FROM friend_personas ORDER BY is_active DESC, id ASC"
  );
}

/**
 * 好友是否已在朋友圈露过面（发过动态或评论过）。
 * 会话列表的私聊入口等 ta 露面后再出现——凭空多出一个不认识的联系人太出戏。
 */
export function hasFriendAppeared(friendId: number): boolean {
  const db = getDB();
  const row = db.getFirstSync<{ cnt: number }>(
    `SELECT
       (SELECT COUNT(*) FROM moments WHERE author = 'friend' AND friend_id = ?)
     + (SELECT COUNT(*) FROM moment_comments WHERE author = 'friend' AND friend_id = ?) AS cnt`,
    friendId,
    friendId
  );
  return (row?.cnt ?? 0) > 0;
}

/** 已启用且已登场的好友（没到登场时间的人不出现在 feed / 会话列表） */
export function getDebutedFriends(nowIso: string = dayjs().toISOString()): FriendPersona[] {
  const db = getDB();
  return db.getAllSync<FriendPersona>(
    "SELECT * FROM friend_personas WHERE is_active = 1 AND is_deleted = 0 AND (debut_at IS NULL OR debut_at <= ?) ORDER BY id ASC",
    nowIso
  );
}

export function getFriendById(friendId: number): FriendPersona | null {
  const db = getDB();
  return (
    db.getFirstSync<FriendPersona>("SELECT * FROM friend_personas WHERE id = ?", friendId) ?? null
  );
}

/** 花名册是否已生成过（含停用者：停用不等于没建过，不能因此自动重掷） */
export function hasFriendRoster(): boolean {
  const db = getDB();
  const row = db.getFirstSync<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM friend_personas WHERE is_deleted = 0"
  );
  return (row?.cnt ?? 0) > 0;
}

export function insertFriendPersona(params: {
  name: string;
  avatar_emoji: string;
  summary: string;
  profile: string;
  debut_at: string | null;
}): number {
  const db = getDB();
  const result = db.runSync(
    "INSERT INTO friend_personas (name, avatar_emoji, summary, profile, is_active, debut_at, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
    params.name,
    params.avatar_emoji,
    params.summary,
    params.profile,
    params.debut_at,
    dayjs().toISOString()
  );
  return Number(result.lastInsertRowId);
}

/** 改名只改称呼，人格小传不动 */
export function updateFriendName(friendId: number, name: string): void {
  const db = getDB();
  db.runSync("UPDATE friend_personas SET name = ? WHERE id = ?", name.trim(), friendId);
}

/** 停用/启用（停用即整人下线，历史记忆保留） */
export function setFriendActive(friendId: number, active: boolean): void {
  const db = getDB();
  db.runSync("UPDATE friend_personas SET is_active = ? WHERE id = ?", active ? 1 : 0, friendId);
}

/** 全部停用（重建花名册：旧人下线、关系记忆保留） */
export function deactivateAllFriends(): void {
  const db = getDB();
  db.runSync("UPDATE friend_personas SET is_active = 0 WHERE is_deleted = 0");
}

/** 清空全部档案（仅用于「首秀前的静默校正」，此时还没有任何关系损失） */
export function deleteAllFriends(): void {
  const db = getDB();
  db.runSync("DELETE FROM friend_personas");
  db.runSync("DELETE FROM post_plan WHERE author = 'friend'");
}

/**
 * 删除好友：停用 + 标记不复活。
 * 档案行保留（名字用于历史动态署名），但不再出现在任何列表/花名册里。
 */
export function deleteFriendPersona(friendId: number): void {
  const db = getDB();
  db.runSync(
    "UPDATE friend_personas SET is_active = 0, is_deleted = 1 WHERE id = ?",
    friendId
  );
  // 未执行的发帖计划一并清掉，避免继续往 feed 里发
  db.runSync("DELETE FROM post_plan WHERE author = 'friend' AND friend_id = ?", friendId);
}

/** 该好友最近一次互动的时刻（动态/评论），没有返回 null */
export function getFriendLastInteraction(friendId: number): string | null {
  const db = getDB();
  const row = db.getFirstSync<{ ts: string | null }>(
    `SELECT MAX(ts) AS ts FROM (
       SELECT MAX(created_at) AS ts FROM moments WHERE friend_id = ?
       UNION ALL
       SELECT MAX(created_at) AS ts FROM moment_comments WHERE friend_id = ?
     )`,
    friendId,
    friendId
  );
  return row?.ts ?? null;
}

/**
 * 与该好友相关（提到名字）的记忆片段，供私聊与「按名字命中档案」使用。
 * 只做 LIKE 粗召回并按时间倒序，不做第二套检索。
 */
export function getFragmentsMentioning(text: string, limit: number = 4): MemoryFragment[] {
  const keyword = text.trim();
  if (!keyword) return [];
  const db = getDB();
  return db.getAllSync<MemoryFragment>(
    `SELECT id, "index", timestamp, gist, summary, keywords, priority
     FROM memory_fragments
     WHERE summary LIKE ? OR gist LIKE ? OR keywords LIKE ?
     ORDER BY timestamp DESC LIMIT ?`,
    `%${keyword}%`,
    `%${keyword}%`,
    `%${keyword}%`,
    limit
  );
}
