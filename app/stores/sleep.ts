import { create } from 'zustand';
import type { SleepSegment } from '../services/sleep';

type SleepMode = 'idle' | 'loading' | 'playing' | 'paused' | 'finished';

interface SleepState {
  mode: SleepMode;
  segments: SleepSegment[];
  currentIndex: number; // 当前播放段落索引
  elapsed: number; // 已播放秒数
  totalDuration: number;
  timerMinutes: number; // 定时关闭（分钟）
  timerRemaining: number; // 定时剩余秒数

  setMode: (mode: SleepMode) => void;
  setSegments: (segments: SleepSegment[], totalDuration: number) => void;
  setCurrentIndex: (index: number) => void;
  setElapsed: (elapsed: number) => void;
  setTimerMinutes: (minutes: number) => void;
  setTimerRemaining: (remaining: number) => void;
  reset: () => void;
}

export const useSleepStore = create<SleepState>((set) => ({
  mode: 'idle',
  segments: [],
  currentIndex: 0,
  elapsed: 0,
  totalDuration: 0,
  timerMinutes: 30,
  timerRemaining: 0,

  setMode: (mode) => set({ mode }),
  setSegments: (segments, totalDuration) => set({ segments, totalDuration }),
  setCurrentIndex: (index) => set({ currentIndex: index }),
  setElapsed: (elapsed) => set({ elapsed }),
  setTimerMinutes: (minutes) => set({ timerMinutes: minutes }),
  setTimerRemaining: (remaining) => set({ timerRemaining: remaining }),
  reset: () =>
    set({
      mode: 'idle',
      segments: [],
      currentIndex: 0,
      elapsed: 0,
      totalDuration: 0,
      timerRemaining: 0,
    }),
}));
