// ============================================================
// 设置 store（API Key 管理）
// ============================================================

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setApiKey, setBaseUrl, hasApiKey } from "@/llm/client";

const API_KEY_STORAGE = "openai_api_key";
const BASE_URL_STORAGE = "openai_base_url";
const NICKNAME_STORAGE = "user_nickname";

const DEFAULT_BASE_URL = "https://api.openai.com";

interface SettingsState {
  apiKey: string;
  baseUrl: string;
  user_nickname: string;
  isReady: boolean;

  /** 从 AsyncStorage 加载配置 */
  loadApiKey: () => Promise<void>;
  /** 保存 API Key */
  saveApiKey: (key: string) => Promise<void>;
  /** 保存 Base URL */
  saveBaseUrl: (url: string) => Promise<void>;
  /** 保存用户称呼 */
  saveUserNickname: (name: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  apiKey: "",
  baseUrl: DEFAULT_BASE_URL,
  user_nickname: "",
  isReady: false,

  loadApiKey: async () => {
    try {
      const [key, url, nickname] = await Promise.all([
        AsyncStorage.getItem(API_KEY_STORAGE),
        AsyncStorage.getItem(BASE_URL_STORAGE),
        AsyncStorage.getItem(NICKNAME_STORAGE),
      ]);
      if (key) {
        setApiKey(key);
      }
      const resolvedUrl = url || DEFAULT_BASE_URL;
      setBaseUrl(resolvedUrl);
      set({ apiKey: key || "", baseUrl: resolvedUrl, user_nickname: nickname || "", isReady: true });
    } catch {
      set({ isReady: true });
    }
  },

  saveApiKey: async (key: string) => {
    await AsyncStorage.setItem(API_KEY_STORAGE, key);
    setApiKey(key);
    set({ apiKey: key });
  },

  saveBaseUrl: async (url: string) => {
    const trimmed = url.trim().replace(/\/+$/, "");
    await AsyncStorage.setItem(BASE_URL_STORAGE, trimmed);
    setBaseUrl(trimmed);
    set({ baseUrl: trimmed });
  },

  saveUserNickname: async (name: string) => {
    const trimmed = name.trim();
    await AsyncStorage.setItem(NICKNAME_STORAGE, trimmed);
    set({ user_nickname: trimmed });
  },
}));
