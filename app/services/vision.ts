import { apiRequest } from './api';

export interface VisionReaction {
  reaction: string;
  mood: string;
}

/** 发送屏幕截图获取静静 Reaction */
export async function analyzeScreen(
  imageBase64: string,
  context = '',
): Promise<VisionReaction> {
  return apiRequest<VisionReaction>('/api/vision/analyze', {
    method: 'POST',
    body: JSON.stringify({ image_base64: imageBase64, context }),
  });
}
