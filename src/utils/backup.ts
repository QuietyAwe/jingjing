// ============================================================
// 数据备份导出/导入
// ============================================================

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import { getDB } from "@/db/connection";
import { getMeta, setMeta } from "@/db/queries";

/** 备份结构版本：只认这一个版本，其它版本直接拒绝导入 */
const BACKUP_VERSION = 2;

/** 自动备份占用上限：超过后从时间线中间开始删，保留首尾 */
const AUTO_BACKUP_MAX_BYTES = 100 * 1024 * 1024; // 100MB
/** 自动备份最少保留份数：即使超上限也不删到低于这个数 */
const MIN_AUTO_BACKUPS = 3;

interface BackupData {
  version: number;
  timestamp: string;
  asyncStorage: Record<string, string>;
  sqlite: {
    memory_events: any[];
    memory_fragments: any[];
    user_info: any[];
    system_metadata: any[];
    behavior_schedule: any[];
    game_sessions: any[];
    moments: any[];
    moment_comments: any[];
    post_plan: any[];
    friend_personas: any[];
    daily_log: any[];
    memory_event_aliases: any[];
    /** AI 检索判定记录（复盘用，缺字段的老备份按空数组处理） */
    retrieval_logs: any[];
  };
}

/** 组装全量备份数据（手动导出与自动备份共用） */
async function buildBackupData(): Promise<BackupData> {
  // 1. 读取 AsyncStorage（聊天记录、设置、提示词等全部 key）
  const keys = await AsyncStorage.getAllKeys();
  const pairs = await AsyncStorage.multiGet(keys);
  const asyncStorage: Record<string, string> = {};
  for (const [key, value] of pairs) {
    if (value !== null) asyncStorage[key] = value;
  }

  // 2. 读取 SQLite
  const db = getDB();
  return {
    version: BACKUP_VERSION,
    timestamp: new Date().toISOString(),
    asyncStorage,
    sqlite: {
      memory_events: db.getAllSync("SELECT * FROM memory_events"),
      memory_fragments: db.getAllSync("SELECT * FROM memory_fragments"),
      user_info: db.getAllSync("SELECT * FROM user_info"),
      system_metadata: db.getAllSync("SELECT * FROM system_metadata"),
      behavior_schedule: db.getAllSync("SELECT * FROM behavior_schedule"),
      game_sessions: db.getAllSync("SELECT * FROM game_sessions"),
      moments: db.getAllSync("SELECT * FROM moments"),
      moment_comments: db.getAllSync("SELECT * FROM moment_comments"),
      post_plan: db.getAllSync("SELECT * FROM post_plan"),
      friend_personas: db.getAllSync("SELECT * FROM friend_personas"),
      daily_log: db.getAllSync("SELECT * FROM daily_log"),
      memory_event_aliases: db.getAllSync("SELECT * FROM memory_event_aliases"),
      retrieval_logs: db.getAllSync("SELECT * FROM retrieval_logs"),
    },
  };
}

/** 导出所有数据 */
export async function exportBackup(): Promise<{ success: boolean; message: string }> {
  try {
    const backup = await buildBackupData();

    // 写入临时文件
    const json = JSON.stringify(backup, null, 2);
    const filename = `jingjing_backup_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
    const fileUri = FileSystem.documentDirectory + filename;
    await FileSystem.writeAsStringAsync(fileUri, json);

    // 4. 分享/保存文件
    await Sharing.shareAsync(fileUri, {
      mimeType: "application/json",
      dialogTitle: "导出备份数据",
    });

    return { success: true, message: backupSummary(backup) };
  } catch (e) {
    console.error("导出失败:", e);
    return { success: false, message: "导出失败：" + (e instanceof Error ? e.message : String(e)) };
  }
}

function backupSummary(backup: BackupData): string {
  const asyncStorage = backup.asyncStorage;
  const chatMsgCount = asyncStorage.chat_messages
    ? JSON.parse(asyncStorage.chat_messages).state?.messages?.length ?? 0
    : 0;
  return [
    `聊天记录: ${chatMsgCount} 条`,
    `记忆事件: ${backup.sqlite.memory_events.length} 个`,
    `记忆片段: ${backup.sqlite.memory_fragments.length} 条`,
    `设置项: ${Object.keys(asyncStorage).length} 个 key`,
  ].join(", ");
}

/** 自动备份：写入应用沙盒 backups/，全部保留，失败静默。force=true 跳过限流（巩固节点用） */
export async function autoBackup(force = false): Promise<void> {
  try {
    // 启动走一天一次兜底；巩固是记忆变化节点，force 跳过限流，每个节点都留一份
    const last = getMeta("last_auto_backup_at");
    if (!force && last && Date.now() - new Date(last).getTime() < 24 * 60 * 60 * 1000) return;
    const data = await buildBackupData();
    const dir = `${FileSystem.documentDirectory}backups/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

    const name = `auto_${data.timestamp.replace(/[:.]/g, "-")}.json`;
    await FileSystem.writeAsStringAsync(`${dir}${name}`, JSON.stringify(data));
    setMeta("last_auto_backup_at", data.timestamp);

    // 总量超限：从中间往两头删，保住最旧和最新两份
    await trimAutoBackups(dir);
  } catch (e) {
    console.error("自动备份失败:", e);
  }
}

/**
 * 备份总量超过 100MB 时腾空间。
 * 按时间正序排列（最旧→最新），删除优先挑离中点最近的，保住两端；
 * 这样最旧那份（完整历史起点）和最新那份（最近状态）都留着，只牺牲中间冗余的。
 */
async function trimAutoBackups(dir: string): Promise<void> {
  const names = (await FileSystem.readDirectoryAsync(dir))
    .filter((f) => f.startsWith("auto_") && f.endsWith(".json"))
    .sort(); // 文件名字典序即时间序

  const fileInfos = await Promise.all(
    names.map(async (name) => {
      const info = await FileSystem.getInfoAsync(`${dir}${name}`);
      return { name, size: info.exists ? ((info as any).size ?? 0) as number : 0 };
    })
  );
  let total = fileInfos.reduce((sum, f) => sum + f.size, 0);
  if (total <= AUTO_BACKUP_MAX_BYTES) return;

  // 离中点越近越先删；两端（index 0 和末尾）最后才动
  const mid = (fileInfos.length - 1) / 2;
  const order = fileInfos
    .map((f, i) => ({ ...f, dist: Math.abs(i - mid) }))
    .sort((a, b) => a.dist - b.dist);

  let remaining = fileInfos.length;
  for (const f of order) {
    // 降到上限以下，或只剩最少保留份数，就停手
    if (total <= AUTO_BACKUP_MAX_BYTES || remaining <= MIN_AUTO_BACKUPS) break;
    await FileSystem.deleteAsync(`${dir}${f.name}`, { idempotent: true });
    total -= f.size;
    remaining--;
  }
}

/**
 * 列出沙盒 backups/ 里的自动备份，按时间倒序。
 * 系统文件选择器访问不到 App 私有目录，恢复必须走 App 内这个列表。
 */
export async function listAutoBackups(): Promise<{ name: string; uri: string; time: string }[]> {
  const dir = `${FileSystem.documentDirectory}backups/`;
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) return [];
  const names = await FileSystem.readDirectoryAsync(dir);
  return names
    .filter((f) => f.startsWith("auto_") && f.endsWith(".json"))
    .map((name) => {
      // auto_2026-11-16T10-30-00-000Z.json → 还原成 ISO 供展示
      const stamp = name.slice(5, -5); // 2026-11-16T10-30-00-000Z
      const time = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z");
      return { name, uri: `${dir}${name}`, time };
    })
    // 文件名字典序即时间序，直接用 name 倒排 newest first
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * 导入备份：选择文件 → 交给 restoreFromUri。
 * 校验与恢复逻辑只此一份，手动导入和自动备份恢复共用，避免两处逻辑漂移。
 */
export async function importBackup(): Promise<{ success: boolean; message: string }> {
  try {
    // 选择文件
    const result = await DocumentPicker.getDocumentAsync({
      type: "application/json",
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) {
      return { success: false, message: "已取消" };
    }
    return await restoreFromUri(result.assets[0].uri);
  } catch (e) {
    console.error("导入失败:", e);
    return { success: false, message: "导入失败：" + (e instanceof Error ? e.message : String(e)) };
  }
}

/** 从指定 uri 读取并恢复备份（手动导入与自动备份恢复共用的核心逻辑） */
export async function restoreFromUri(fileUri: string): Promise<{ success: boolean; message: string }> {
  try {
    // 读取文件
    const json = await FileSystem.readAsStringAsync(fileUri);
    const backup: BackupData = JSON.parse(json);

    // 验证版本：结构不一致的备份导进来会让「当前处境」整块失效
    if (backup.version !== BACKUP_VERSION || !backup.asyncStorage || !backup.sqlite) {
      return {
        success: false,
        message: `备份文件版本不匹配（需要 v${BACKUP_VERSION}，文件是 v${backup.version ?? "未知"}）`,
      };
    }

    // 恢复 AsyncStorage（先清空旧数据再写入，避免残留）
    const existingKeys = await AsyncStorage.getAllKeys();
    if (existingKeys.length > 0) await AsyncStorage.multiRemove(existingKeys);
    const pairs = Object.entries(backup.asyncStorage);
    await AsyncStorage.multiSet(pairs);

    // 恢复 SQLite
    const db = getDB();
    db.execSync("DELETE FROM memory_fragments");
    db.execSync("DELETE FROM memory_events");
    db.execSync("DELETE FROM game_sessions");
    db.execSync("DELETE FROM moment_comments");
    db.execSync("DELETE FROM moments");
    db.execSync("DELETE FROM post_plan");
    db.execSync("DELETE FROM user_info");
    db.execSync("DELETE FROM system_metadata");
    db.execSync("DELETE FROM behavior_schedule");
    db.execSync("DELETE FROM friend_personas");
    db.execSync("DELETE FROM daily_log");
    // 别名指向 memory_events.id：不先清会让旧别名挂到恢复后被复用 id 的另一条事件上
    db.execSync("DELETE FROM memory_event_aliases");
    // 判定记录跟着备份走，不先清会混着上一台设备的旧记录
    db.execSync("DELETE FROM retrieval_logs");

    // 恢复 memory_events（memory_kind / event_status / closed_at 必须一并恢复，
    // 否则共同经历会退化成日常琐事、处境会变回普通记忆）
    for (const row of backup.sqlite.memory_events) {
      db.runSync(
        "INSERT INTO memory_events (id, event_text, timestamp, active_weight, last_accessed, priority, memory_kind, event_status, closed_at, nudge_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        row.id,
        row.event_text,
        row.timestamp,
        row.active_weight,
        row.last_accessed,
        row.priority ?? 5,
        row.memory_kind ?? "daily",
        row.event_status ?? "none",
        row.closed_at ?? null,
        row.nudge_count ?? 0
      );
    }

    // 恢复 memory_fragments
    for (const row of backup.sqlite.memory_fragments) {
      db.runSync(
        'INSERT INTO memory_fragments (id, "index", timestamp, gist, summary, keywords, priority) VALUES (?, ?, ?, ?, ?, ?, ?)',
        row.id, row.index, row.timestamp, row.gist ?? "", row.summary, row.keywords ?? "", row.priority ?? 5
      );
    }

    // 恢复事件别名
    for (const row of backup.sqlite.memory_event_aliases ?? []) {
      db.runSync(
        "INSERT OR IGNORE INTO memory_event_aliases (event_id, alias) VALUES (?, ?)",
        row.event_id, row.alias
      );
    }

    // 恢复检索判定记录（老备份里没有这一项，按空数组处理）
    for (const row of backup.sqlite.retrieval_logs ?? []) {
      db.runSync(
        `INSERT INTO retrieval_logs
           (id, created_at, user_text, stage1_output, stage2_output, final_injected, fallback, event_count, expand_used, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.created_at,
        row.user_text,
        row.stage1_output ?? null,
        row.stage2_output ?? null,
        row.final_injected ?? "",
        row.fallback ?? 0,
        row.event_count ?? 0,
        row.expand_used ?? 0,
        row.latency_ms ?? 0
      );
    }

    // 恢复 user_info
    for (const row of backup.sqlite.user_info) {
      db.runSync(
        "INSERT INTO user_info (key, value) VALUES (?, ?)",
        row.key, row.value
      );
    }

    // 恢复 system_metadata
    for (const row of backup.sqlite.system_metadata) {
      db.runSync(
        "INSERT INTO system_metadata (key, value) VALUES (?, ?)",
        row.key, row.value
      );
    }
    // 备份可能带着巩固锁（导出时恰逢巩固中）：恢复后若 is_locked=true 会让巩固永久卡死到下次重启
    db.runSync(
      'INSERT INTO system_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      "is_locked",
      "false"
    );

    // 恢复 behavior_schedule
    for (const row of backup.sqlite.behavior_schedule) {
      db.runSync(
        "INSERT INTO behavior_schedule (id, week_start, day_of_week, time_slot, activity, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        row.id, row.week_start, row.day_of_week, row.time_slot, row.activity, row.created_at
      );
    }

    // 恢复游戏对局与心情动态
    for (const row of backup.sqlite.game_sessions ?? []) {
      db.runSync(
        `INSERT INTO game_sessions (id, game_type, mode, status, secret, secret_source, question_count, turns, started_at, ended_at, result_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.game_type, row.mode, row.status, row.secret, row.secret_source,
        row.question_count ?? 0, row.turns ?? "[]", row.started_at, row.ended_at ?? null, row.result_note ?? null
      );
    }
    // 好友档案先于动态恢复：动态的 friend_id 指向它们
    for (const row of backup.sqlite.friend_personas ?? []) {
      db.runSync(
        "INSERT INTO friend_personas (id, name, avatar_emoji, summary, profile, is_active, is_deleted, debut_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        row.id, row.name, row.avatar_emoji ?? "", row.summary ?? "", row.profile ?? "",
        row.is_active ?? 1, row.is_deleted ?? 0, row.debut_at ?? null, row.created_at
      );
    }
    for (const row of backup.sqlite.daily_log ?? []) {
      db.runSync(
        "INSERT INTO daily_log (day, slots, mood, highlight, late_night, weather, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        row.day, row.slots ?? "", row.mood ?? "", row.highlight ?? "", row.late_night ?? "",
        row.weather ?? "", row.created_at, row.updated_at ?? row.created_at
      );
    }
    for (const row of backup.sqlite.moments ?? []) {
      db.runSync(
        "INSERT INTO moments (id, author, content, mood, created_at, friend_id) VALUES (?, ?, ?, ?, ?, ?)",
        row.id, row.author, row.content, row.mood ?? "", row.created_at, row.friend_id ?? null
      );
    }
    for (const row of backup.sqlite.moment_comments ?? []) {
      db.runSync(
        "INSERT INTO moment_comments (id, moment_id, author, content, created_at, friend_id) VALUES (?, ?, ?, ?, ?, ?)",
        row.id, row.moment_id, row.author, row.content, row.created_at, row.friend_id ?? null
      );
    }
    for (const row of backup.sqlite.post_plan ?? []) {
      db.runSync(
        "INSERT INTO post_plan (id, week_start, day_of_week, time_slot, theme_hint, status, created_at, author, friend_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        row.id, row.week_start, row.day_of_week, row.time_slot, row.theme_hint ?? "",
        row.status ?? "pending", row.created_at, row.author ?? "ai", row.friend_id ?? null
      );
    }

    return { success: true, message: `备份恢复成功（${backup.timestamp}）` };
  } catch (e) {
    console.error("导入失败:", e);
    return { success: false, message: "导入失败：" + (e instanceof Error ? e.message : String(e)) };
  }
}
