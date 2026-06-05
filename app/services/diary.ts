import { apiRequest } from './api';

export interface DiaryEntry {
  id: number;
  user_id: number;
  content: string;
  image_tag: string | null;
  mood: string | null;
  likes: number;
  comment_count: number;
  created_at: string;
}

export interface DiaryComment {
  id: number;
  diary_id: number;
  user_id: number;
  content: string;
  created_at: string;
}

/** 获取日记列表 */
export async function getDiaries(userId: number, page = 1): Promise<DiaryEntry[]> {
  return apiRequest<DiaryEntry[]>(`/api/diary/${userId}?page=${page}&size=10`);
}

/** 手动生成日记 */
export async function generateDiary(
  userId: number,
  timeOfDay: string,
  weatherText: string,
): Promise<DiaryEntry> {
  return apiRequest<DiaryEntry>(
    `/api/diary/${userId}/generate?time_of_day=${encodeURIComponent(timeOfDay)}&weather_text=${encodeURIComponent(weatherText)}`,
    { method: 'POST' },
  );
}

/** 点赞日记 */
export async function likeDiary(diaryId: number): Promise<{ likes: number }> {
  return apiRequest<{ likes: number }>(`/api/diary/${diaryId}/like`, { method: 'POST' });
}

/** 添加评论 */
export async function addComment(
  diaryId: number,
  userId: number,
  content: string,
): Promise<DiaryComment> {
  return apiRequest<DiaryComment>(
    `/api/diary/${diaryId}/comment?user_id=${userId}`,
    {
      method: 'POST',
      body: JSON.stringify({ content }),
    },
  );
}

/** 获取评论列表 */
export async function getComments(diaryId: number): Promise<DiaryComment[]> {
  return apiRequest<DiaryComment[]>(`/api/diary/${diaryId}/comments`);
}
