const BASE_URL = 'http://localhost:8000';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

/**
 * 发送消息并处理 SSE 流式响应
 */
export async function sendChatMessage(
  userId: number,
  content: string,
  callbacks: StreamCallbacks
): Promise<void> {
  try {
    const response = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, content }),
    });

    if (!response.ok) {
      callbacks.onError(`HTTP ${response.status}`);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      callbacks.onError('No response body');
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'token') {
            callbacks.onToken(data.content);
          } else if (data.type === 'done') {
            callbacks.onDone();
          } else if (data.type === 'error') {
            callbacks.onError(data.message);
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  } catch (error) {
    callbacks.onError(String(error));
  }
}
