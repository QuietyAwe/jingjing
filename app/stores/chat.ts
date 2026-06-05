import { create } from 'zustand';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  audioBase64?: string; // TTS 音频（base64）
  audioDuration?: number; // 音频时长（秒）
}

interface ChatState {
  messages: Message[];
  isTyping: boolean;
  isDrawerOpen: boolean;
  isRecording: boolean; // 录音状态

  addMessage: (msg: Message) => void;
  appendToLastMessage: (content: string) => void;
  setLastMessageAudio: (audioBase64: string, duration: number) => void;
  setTyping: (typing: boolean) => void;
  setDrawerOpen: (open: boolean) => void;
  setRecording: (recording: boolean) => void;
  clearMessages: () => void;
}

let messageCounter = 0;
function genId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isTyping: false,
  isDrawerOpen: false,
  isRecording: false,

  addMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),

  appendToLastMessage: (content) =>
    set((state) => {
      const msgs = [...state.messages];
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...msgs[msgs.length - 1],
          content: msgs[msgs.length - 1].content + content,
        };
      }
      return { messages: msgs };
    }),

  setLastMessageAudio: (audioBase64, duration) =>
    set((state) => {
      const msgs = [...state.messages];
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
        msgs[msgs.length - 1] = {
          ...msgs[msgs.length - 1],
          audioBase64,
          audioDuration: duration,
        };
      }
      return { messages: msgs };
    }),

  setTyping: (typing) => set({ isTyping: typing }),
  setDrawerOpen: (open) => set({ isDrawerOpen: open }),
  setRecording: (recording) => set({ isRecording: recording }),
  clearMessages: () => set({ messages: [] }),
}));

export { genId };
