import { apiRequest } from './api';

export interface TTSResult {
  audio: string; // base64
  format: string;
  duration: number;
}

/** 文本转语音 */
export async function generateTTS(text: string, voiceId = 'default'): Promise<TTSResult> {
  return apiRequest<TTSResult>('/api/voice/tts', {
    method: 'POST',
    body: JSON.stringify({ text, voice_id: voiceId }),
  });
}

/** 语音转文字（FormData 上传） */
export async function transcribeAudio(
  audioBase64: string,
  format = 'wav',
): Promise<{ text: string }> {
  // 使用 base64 传输（简化实现，生产环境建议 FormData）
  return apiRequest<{ text: string }>('/api/voice/asr', {
    method: 'POST',
    body: JSON.stringify({ audio: audioBase64, format }),
  });
}
