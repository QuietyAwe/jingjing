// ============================================================
// 数据备份导出/导入
// ============================================================

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import { getDB } from "@/db/connection";

const BACKUP_VERSION = 1;

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
    // v1.0.8 起补齐的四张表（旧备份文件里没有，导入时按空处理）
    game_sessions?: any[];
    moments?: any[];
    moment_comments?: any[];
    post_plan?: any[];
    // 好友圈与每日实况（旧备份没有，按空处理）
    friend_personas?: any[];
    daily_log?: any[];
  };
}

/** 导出所有数据 */
export async function exportBackup(): Promise<{ success: boolean; message: string }> {
  try {
    // 1. 读取 AsyncStorage（聊天记录、设置、提示词等全部 key）
    const keys = await AsyncStorage.getAllKeys();
    const pairs = await AsyncStorage.multiGet(keys);
    const asyncStorage: Record<string, string> = {};
    for (const [key, value] of pairs) {
      if (value !== null) asyncStorage[key] = value;
    }

    // 2. 读取 SQLite
    const db = getDB();
    const memory_events = db.getAllSync("SELECT * FROM memory_events");
    const memory_fragments = db.getAllSync("SELECT * FROM memory_fragments");
    const user_info = db.getAllSync("SELECT * FROM user_info");
    const system_metadata = db.getAllSync("SELECT * FROM system_metadata");
    const behavior_schedule = db.getAllSync("SELECT * FROM behavior_schedule");
    const game_sessions = db.getAllSync("SELECT * FROM game_sessions");
    const moments = db.getAllSync("SELECT * FROM moments");
    const moment_comments = db.getAllSync("SELECT * FROM moment_comments");
    const post_plan = db.getAllSync("SELECT * FROM post_plan");
    const friend_personas = db.getAllSync("SELECT * FROM friend_personas");
    const daily_log = db.getAllSync("SELECT * FROM daily_log");

    const backup: BackupData = {
      version: BACKUP_VERSION,
      timestamp: new Date().toISOString(),
      asyncStorage,
      sqlite: {
        memory_events,
        memory_fragments,
        user_info,
        system_metadata,
        behavior_schedule,
        game_sessions,
        moments,
        moment_comments,
        post_plan,
        friend_personas,
        daily_log,
      },
    };

    // 3. 写入临时文件
    const json = JSON.stringify(backup, null, 2);
    const filename = `jingjing_backup_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
    const fileUri = FileSystem.documentDirectory + filename;
    await FileSystem.writeAsStringAsync(fileUri, json);

    // 4. 分享/保存文件
    await Sharing.shareAsync(fileUri, {
      mimeType: "application/json",
      dialogTitle: "导出备份数据",
    });

    // 返回摘要
    const chatMsgCount = asyncStorage.chat_messages
      ? JSON.parse(asyncStorage.chat_messages).state?.messages?.length ?? 0
      : 0;
    const summary = [
      `聊天记录: ${chatMsgCount} 条`,
      `记忆事件: ${memory_events.length} 个`,
      `记忆片段: ${memory_fragments.length} 条`,
      `设置项: ${Object.keys(asyncStorage).length} 个 key`,
    ].join(", ");
    return { success: true, message: summary };
  } catch (e) {
    console.error("导出失败:", e);
    return { success: false, message: "导出失败：" + (e instanceof Error ? e.message : String(e)) };
  }
}

/** 导入备份数据 */
export async function importBackup(): Promise<{ success: boolean; message: string }> {
  try {
    // 1. 选择文件
    const result = await DocumentPicker.getDocumentAsync({
      type: "application/json",
      copyToCacheDirectory: true,
    });

    if (result.canceled || !result.assets?.[0]) {
      return { success: false, message: "已取消" };
    }

    // 2. 读取文件
    const fileUri = result.assets[0].uri;
    const json = await FileSystem.readAsStringAsync(fileUri);
    const backup: BackupData = JSON.parse(json);

    // 3. 验证版本
    if (!backup.version || !backup.asyncStorage || !backup.sqlite) {
      return { success: false, message: "备份文件格式无效" };
    }

    // 4. 恢复 AsyncStorage（先清空旧数据再写入，避免残留）
    const existingKeys = await AsyncStorage.getAllKeys();
    if (existingKeys.length > 0) await AsyncStorage.multiRemove(existingKeys);
    const pairs = Object.entries(backup.asyncStorage);
    await AsyncStorage.multiSet(pairs);

    // 5. 恢复 SQLite
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

    // 恢复 memory_events（旧备份可能仍含 "index" / is_archived，已废弃列不再写入；
    // memory_kind 必须一并恢复，否则 episode 共同经历会退化成 daily、丢失按天衰减与权重下限）
    for (const row of backup.sqlite.memory_events) {
      db.runSync(
        "INSERT INTO memory_events (id, event_text, timestamp, active_weight, last_accessed, priority, memory_kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
        row.id,
        row.event_text,
        row.timestamp,
        row.active_weight,
        row.last_accessed,
        row.priority ?? 5,
        row.memory_kind ?? "daily"
      );
    }

    // 恢复 memory_fragments
    for (const row of backup.sqlite.memory_fragments) {
      // 旧备份带 emotion 列：并进 summary，避免丢信息
      const legacyEmotion = typeof row.emotion === "string" ? row.emotion.trim() : "";
      const summary = legacyEmotion ? `${row.summary}（${legacyEmotion}）` : row.summary;
      db.runSync(
        'INSERT INTO memory_fragments (id, "index", timestamp, gist, summary, keywords, priority) VALUES (?, ?, ?, ?, ?, ?, ?)',
        row.id, row.index, row.timestamp, row.gist ?? "", summary, row.keywords ?? "", row.priority ?? 5
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

    // 恢复游戏对局与心情动态（旧备份没有这四张表，按空处理）
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
