import { create } from 'zustand';

interface SettingsState {
  ttsVolume: number;        // 0-1
  ambientVolume: number;    // 0-1
  darkMode: 'system' | 'light' | 'dark' | 'sync';
  dynamicEffects: boolean;
  careMode: 'clingy' | 'normal' | 'dnd';

  setTtsVolume: (v: number) => void;
  setAmbientVolume: (v: number) => void;
  setDarkMode: (m: 'system' | 'light' | 'dark' | 'sync') => void;
  setDynamicEffects: (on: boolean) => void;
  setCareMode: (m: 'clingy' | 'normal' | 'dnd') => void;
  loadFromServer: (data: Partial<SettingsState>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ttsVolume: 0.8,
  ambientVolume: 0.15,
  darkMode: 'system',
  dynamicEffects: true,
  careMode: 'normal',

  setTtsVolume: (v) => set({ ttsVolume: v }),
  setAmbientVolume: (v) => set({ ambientVolume: v }),
  setDarkMode: (m) => set({ darkMode: m }),
  setDynamicEffects: (on) => set({ dynamicEffects: on }),
  setCareMode: (m) => set({ careMode: m }),
  loadFromServer: (data) => set(data),
}));
