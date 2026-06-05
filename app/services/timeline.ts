import { apiRequest } from './api';

export interface MemoryCard {
  id: number;
  content: string;
  category: string;
  created_at: string;
  related_messages: Array<{ role: string; content: string }>;
}

export interface GiftResult {
  success: boolean;
  message: string;
}

export interface BackupResult {
  success: boolean;
  count: number;
  message: string;
}

export interface ExportData {
  user_name: string;
  memories: Array<{ content: string; category: string; created_at: string }>;
  recent_messages: Array<{ role: string; content: string }>;
}

/** 获取记忆回廊卡片 */
export async function getMemoryCards(userId: number): Promise<MemoryCard[]> {
  return apiRequest<MemoryCard[]>(`/api/timeline/${userId}/memories`);
}

/** 获取记忆上下文 */
export async function getMemoryContext(
  userId: number,
  memoryId: number,
): Promise<{ memory: any; context_messages: any[] }> {
  return apiRequest(`/api/timeline/${userId}/memory/${memoryId}/context`);
}

/** 送出虚拟礼物 */
export async function sendGift(
  userId: number,
  giftType: string,
  message = '',
): Promise<GiftResult> {
  return apiRequest<GiftResult>(
    `/api/timeline/${userId}/gift?gift_type=${encodeURIComponent(giftType)}&message=${encodeURIComponent(message)}`,
    { method: 'POST' },
  );
}

/** 数据备份 */
export async function backupData(userId: number): Promise<BackupResult> {
  return apiRequest<BackupResult>(`/api/timeline/${userId}/backup`);
}

/** 导出时空日志 */
export async function exportTimeline(userId: number): Promise<ExportData> {
  return apiRequest<ExportData>(`/api/timeline/${userId}/export`);
}
