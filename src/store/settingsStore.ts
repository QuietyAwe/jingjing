// ============================================================
// 设置 store（API Key 管理）
// ============================================================

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setApiKey, setBaseUrl, hasApiKey } from "@/llm/client";
import { getUserInfo, updateBasicIdentityNickname } from "@/db/queries";

const API_KEY_STORAGE = "openai_api_key";
const BASE_URL_STORAGE = "openai_base_url";
/** 已废弃：昵称真相源统一为 user_info.basic_identity.nickname，此 key 仅用于旧数据迁移 */
const LEGACY_NICKNAME_STORAGE = "user_nickname";
const AI_NAME_STORAGE = "ai_name";
const STREAM_OUTPUT_STORAGE = "stream_output";
const THINKING_MODE_STORAGE = "thinking_mode";
const AUTO_FOCUS_INPUT_STORAGE = "auto_focus_input";
const BLOCKED_KEYWORDS_STORAGE = "blocked_keywords";
/** 好友偏好（对 AI 熟人圈的持续约束：交谁 + 怎么处），空串 = 不约束 */
const FRIEND_PREFERENCES_STORAGE = "friend_preferences";
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
  /** 用户称呼（数据库 user_info.basic_identity.nickname 的内存镜像） */
  user_nickname: string;
  ai_name: string;
  stream_output: boolean;
  thinking_mode: boolean;
  /** AI 回复完成后自动聚焦输入框（弹起键盘），方便继续输入 */
  auto_focus_input: boolean;
  /** 检索屏蔽词（逗号/顿号分隔原文）。空串 = 未配置，默认屏蔽用户昵称 + AI 名称 */
  blocked_keywords: string;
  /** 好友偏好：约束 AI 熟人圈结交谁、怎么相处；空串 = 不约束 */
  friend_preferences: string;
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
  /** 从数据库同步用户称呼到内存 */
  syncNicknameFromDB: () => void;
  /** 保存流式输出开关 */
  saveStreamOutput: (enabled: boolean) => Promise<void>;
  /** 保存思考模式开关 */
  saveThinkingMode: (enabled: boolean) => Promise<void>;
  /** 保存「回复后自动弹起输入框」开关 */
  saveAutoFocusInput: (enabled: boolean) => Promise<void>;
  /** 保存检索屏蔽词（原文落库，切分解析交给 memory/identity.blockedWords） */
  saveBlockedKeywords: (value: string) => Promise<void>;
  /** 保存好友偏好（原文落库，直接注入好友相关 prompt） */
  saveFriendPreferences: (value: string) => Promise<void>;
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
  auto_focus_input: true,
  blocked_keywords: "",
  friend_preferences: "",
  customColorsLight: {} as CustomBubbleColors,
  customColorsDark: {} as CustomBubbleColors,
  isReady: false,

  loadApiKey: async () => {
    try {
      const [key, url, legacyNickname, aiName, stream, thinking, autoFocus, blocked, friendPrefs, lightJson, darkJson] = await Promise.all([
        AsyncStorage.getItem(API_KEY_STORAGE),
        AsyncStorage.getItem(BASE_URL_STORAGE),
        AsyncStorage.getItem(LEGACY_NICKNAME_STORAGE),
        AsyncStorage.getItem(AI_NAME_STORAGE),
        AsyncStorage.getItem(STREAM_OUTPUT_STORAGE),
        AsyncStorage.getItem(THINKING_MODE_STORAGE),
        AsyncStorage.getItem(AUTO_FOCUS_INPUT_STORAGE),
        AsyncStorage.getItem(BLOCKED_KEYWORDS_STORAGE),
        AsyncStorage.getItem(FRIEND_PREFERENCES_STORAGE),
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

      // 昵称真相源统一到 user_info 表：旧 AsyncStorage 值迁移一次后即弃用
      let nickname = getUserInfo()?.basic_identity?.nickname ?? "";
      if (!nickname && legacyNickname) {
        nickname = legacyNickname.trim();
        if (nickname) updateBasicIdentityNickname(nickname);
        await AsyncStorage.removeItem(LEGACY_NICKNAME_STORAGE);
      }

      set({
        apiKey: key || "",
        baseUrl: resolvedUrl,
        user_nickname: nickname,
        ai_name: aiName || "",
        stream_output: stream === "true",
        thinking_mode: thinking === "true",
        // 默认开启；显式存过 "false" 才关闭
        auto_focus_input: autoFocus !== "false",
        blocked_keywords: blocked || "",
        friend_preferences: friendPrefs || "",
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

  /** 用户称呼的唯一写入口：写 user_info 表，AsyncStorage 不再保存副本 */
  saveUserNickname: async (name: string) => {
    const trimmed = name.trim();
    updateBasicIdentityNickname(trimmed);
    set({ user_nickname: trimmed });
  },

  saveAiName: async (name: string) => {
    const trimmed = name.trim();
    await AsyncStorage.setItem(AI_NAME_STORAGE, trimmed);
    set({ ai_name: trimmed });
  },

  syncNicknameFromDB: () => {
    set({ user_nickname: getUserInfo()?.basic_identity?.nickname ?? "" });
  },

  saveStreamOutput: async (enabled: boolean) => {
    await AsyncStorage.setItem(STREAM_OUTPUT_STORAGE, String(enabled));
    set({ stream_output: enabled });
  },

  saveThinkingMode: async (enabled: boolean) => {
    await AsyncStorage.setItem(THINKING_MODE_STORAGE, String(enabled));
    set({ thinking_mode: enabled });
  },

  saveAutoFocusInput: async (enabled: boolean) => {
    await AsyncStorage.setItem(AUTO_FOCUS_INPUT_STORAGE, String(enabled));
    set({ auto_focus_input: enabled });
  },

  saveBlockedKeywords: async (value: string) => {
    const trimmed = value.trim();
    await AsyncStorage.setItem(BLOCKED_KEYWORDS_STORAGE, trimmed);
    set({ blocked_keywords: trimmed });
  },

  saveFriendPreferences: async (value: string) => {
    const trimmed = value.trim();
    await AsyncStorage.setItem(FRIEND_PREFERENCES_STORAGE, trimmed);
    set({ friend_preferences: trimmed });
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
