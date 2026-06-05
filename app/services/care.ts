import { apiRequest } from './api';

export interface CareCheckResult {
  daily_care: Array<{ user_id: number; message: string }>;
  special_events: Array<{ user_id: number; message: string }>;
  total: number;
}

/** 执行关怀检查（返回需要推送的消息） */
export async function checkCare(): Promise<CareCheckResult> {
  return apiRequest<CareCheckResult>('/api/care/check');
}

/** 标记用户为活跃 */
export async function markActive(userId: number): Promise<void> {
  await apiRequest(`/api/care/active/${userId}`, { method: 'POST' });
}
