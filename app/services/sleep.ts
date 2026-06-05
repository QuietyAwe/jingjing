import { apiRequest } from './api';

export interface SleepSegment {
  audio: string; // base64
  text: string;
  duration: number; // 秒
  volume: number; // 0-1 音量衰减系数
}

export interface SleepAudio {
  segments: SleepSegment[];
  total_duration: number; // 秒
}

/** 生成晚安守护音频 */
export async function generateSleepAudio(
  userId: number,
  durationMin = 30,
): Promise<SleepAudio> {
  return apiRequest<SleepAudio>(
    `/api/sleep/${userId}/generate?duration_min=${durationMin}`,
  );
}
