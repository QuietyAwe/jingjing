// ============================================================
// 设置 store（API Key 管理）
// ============================================================

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setApiKey, hasApiKey } from "@/llm/client";

const API_KEY_STORAGE = "openai_api_key";

interface SettingsState {
  apiKey: string;
  isReady: boolean;

  /** 从 AsyncStorage 加载 API Key */
  loadApiKey: () => Promise<void>;
  /** 保存 API Key */
  saveApiKey: (key: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  apiKey: "",
  isReady: false,

  loadApiKey: async () => {
    try {
      const key = await AsyncStorage.getItem(API_KEY_STORAGE);
      if (key) {
        setApiKey(key);
        set({ apiKey: key, isReady: true });
      } else {
        set({ isReady: true });
      }
    } catch {
      set({ isReady: true });
    }
  },

  saveApiKey: async (key: string) => {
    await AsyncStorage.setItem(API_KEY_STORAGE, key);
    setApiKey(key);
    set({ apiKey: key });
  },
}));
