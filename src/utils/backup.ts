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

    const backup: BackupData = {
      version: BACKUP_VERSION,
      timestamp: new Date().toISOString(),
      asyncStorage,
      sqlite: { memory_events, memory_fragments, user_info, system_metadata, behavior_schedule },
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
    db.execSync("DELETE FROM user_info");
    db.execSync("DELETE FROM system_metadata");
    db.execSync("DELETE FROM behavior_schedule");

    // 恢复 memory_events
    for (const row of backup.sqlite.memory_events) {
      db.runSync(
        'INSERT INTO memory_events (id, "index", event_text, timestamp, active_weight, last_accessed, is_archived, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        row.id, row.index, row.event_text, row.timestamp, row.active_weight, row.last_accessed, row.is_archived, row.priority
      );
    }

    // 恢复 memory_fragments
    for (const row of backup.sqlite.memory_fragments) {
      db.runSync(
        'INSERT INTO memory_fragments (id, "index", timestamp, summary, emotion, priority) VALUES (?, ?, ?, ?, ?, ?)',
        row.id, row.index, row.timestamp, row.summary, row.emotion, row.priority
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

    // 恢复 behavior_schedule
    for (const row of backup.sqlite.behavior_schedule) {
      db.runSync(
        "INSERT INTO behavior_schedule (id, week_start, day_of_week, time_slot, activity, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        row.id, row.week_start, row.day_of_week, row.time_slot, row.activity, row.created_at
      );
    }

    return { success: true, message: `备份恢复成功（${backup.timestamp}）` };
  } catch (e) {
    console.error("导入失败:", e);
    return { success: false, message: "导入失败：" + (e instanceof Error ? e.message : String(e)) };
  }
}
