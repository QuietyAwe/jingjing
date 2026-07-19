// ============================================================
// 设置 store（API Key 管理）
// ============================================================

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setApiKey, setBaseUrl, hasApiKey } from "@/llm/client";

const API_KEY_STORAGE = "openai_api_key";
const BASE_URL_STORAGE = "openai_base_url";
const NICKNAME_STORAGE = "user_nickname";
const AI_NAME_STORAGE = "ai_name";
const STREAM_OUTPUT_STORAGE = "stream_output";
const THINKING_MODE_STORAGE = "thinking_mode";
const CUSTOM_COLORS_LIGHT_STORAGE = "custom_colors_light";
const CUSTOM_COLORS_DARK_STORAGE = "custom_colors_dark";

const DEFAULT_BASE_URL = "https://api.openai.com";

/** 自定义气泡颜色配置 */
export interface CustomBubbleColors {
  /** 用户消息背景色 */
  bubbleUserBg: string;
  /** 用户消息文字色 */
  bubbleUserText: string;
  /** AI 消息背景色 */
  bubbleAiBg: string;
  /** AI 消息文字色 */
  bubbleAiText: string;
}

interface SettingsState {
  apiKey: string;
  baseUrl: string;
  user_nickname: string;
  ai_name: string;
  stream_output: boolean;
  thinking_mode: boolean;
  customColorsLight: CustomBubbleColors;
  customColorsDark: CustomBubbleColors;
  isReady: boolean;

  /** 从 AsyncStorage 加载配置 */
  loadApiKey: () => Promise<void>;
  /** 保存 API Key */
  saveApiKey: (key: string) => Promise<void>;
  /** 保存 Base URL */
  saveBaseUrl: (url: string) => Promise<void>;
  /** 保存用户称呼 */
  saveUserNickname: (name: string) => Promise<void>;
  /** 保存 AI 名字 */
  saveAiName: (name: string) => Promise<void>;
  /** 保存流式输出开关 */
  saveStreamOutput: (enabled: boolean) => Promise<void>;
  /** 保存思考模式开关 */
  saveThinkingMode: (enabled: boolean) => Promise<void>;
  /** 保存自定义颜色（当前模式） */
  saveCustomColors: (colors: Partial<CustomBubbleColors>, mode: "light" | "dark") => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  apiKey: "",
  baseUrl: DEFAULT_BASE_URL,
  user_nickname: "",
  ai_name: "",
  stream_output: false,
  thinking_mode: false,
  customColorsLight: {} as CustomBubbleColors,
  customColorsDark: {} as CustomBubbleColors,
  isReady: false,

  loadApiKey: async () => {
    try {
      const [key, url, nickname, aiName, stream, thinking, lightJson, darkJson] = await Promise.all([
        AsyncStorage.getItem(API_KEY_STORAGE),
        AsyncStorage.getItem(BASE_URL_STORAGE),
        AsyncStorage.getItem(NICKNAME_STORAGE),
        AsyncStorage.getItem(AI_NAME_STORAGE),
        AsyncStorage.getItem(STREAM_OUTPUT_STORAGE),
        AsyncStorage.getItem(THINKING_MODE_STORAGE),
        AsyncStorage.getItem(CUSTOM_COLORS_LIGHT_STORAGE),
        AsyncStorage.getItem(CUSTOM_COLORS_DARK_STORAGE),
      ]);
      if (key) {
        setApiKey(key);
      }
      const resolvedUrl = url || DEFAULT_BASE_URL;
      setBaseUrl(resolvedUrl);

      let customColorsLight = {} as CustomBubbleColors;
      let customColorsDark = {} as CustomBubbleColors;
      if (lightJson) {
        try { customColorsLight = JSON.parse(lightJson); } catch {}
      }
      if (darkJson) {
        try { customColorsDark = JSON.parse(darkJson); } catch {}
      }

      set({
        apiKey: key || "",
        baseUrl: resolvedUrl,
        user_nickname: nickname || "",
        ai_name: aiName || "",
        stream_output: stream === "true",
        thinking_mode: thinking === "true",
        customColorsLight,
        customColorsDark,
        isReady: true,
      });
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

  saveAiName: async (name: string) => {
    const trimmed = name.trim();
    await AsyncStorage.setItem(AI_NAME_STORAGE, trimmed);
    set({ ai_name: trimmed });
  },

  saveStreamOutput: async (enabled: boolean) => {
    await AsyncStorage.setItem(STREAM_OUTPUT_STORAGE, String(enabled));
    set({ stream_output: enabled });
  },

  saveThinkingMode: async (enabled: boolean) => {
    await AsyncStorage.setItem(THINKING_MODE_STORAGE, String(enabled));
    set({ thinking_mode: enabled });
  },

  saveCustomColors: async (colors: Partial<CustomBubbleColors>, mode: "light" | "dark") => {
    const state = useSettingsStore.getState();
    const current = mode === "light" ? state.customColorsLight : state.customColorsDark;
    const updated = { ...current, ...colors };
    const storageKey = mode === "light" ? CUSTOM_COLORS_LIGHT_STORAGE : CUSTOM_COLORS_DARK_STORAGE;
    await AsyncStorage.setItem(storageKey, JSON.stringify(updated));
    if (mode === "light") {
      set({ customColorsLight: updated });
    } else {
      set({ customColorsDark: updated });
    }
  },
}));
