import { create } from 'zustand';

interface HomeState {
  // 场景数据
  timeOfDay: string;
  weatherText: string;

  // 状态文字
  currentStatusText: string;

  // UI 状态
  isDrawerOpen: boolean;
  isReturningUser: boolean;

  // Actions
  setWeather: (timeOfDay: string, weatherText: string) => void;
  setStatusText: (text: string) => void;
  setDrawerOpen: (open: boolean) => void;
  setReturningUser: (isReturning: boolean) => void;
}

export const useHomeStore = create<HomeState>((set) => ({
  timeOfDay: '深夜',
  weatherText: '晴',
  currentStatusText: '静静在窗边等你...',
  isDrawerOpen: false,
  isReturningUser: false,

  setWeather: (timeOfDay, weatherText) => set({ timeOfDay, weatherText }),
  setStatusText: (text) => set({ currentStatusText: text }),
  setDrawerOpen: (open) => set({ isDrawerOpen: open }),
  setReturningUser: (isReturning) => set({ isReturningUser: isReturning }),
}));
