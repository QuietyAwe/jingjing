// ============================================================
// 主题管理 — Zustand store + useTheme hook
// ============================================================

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { lightColors, darkColors, type ColorPalette } from "./colors";
import { useSettingsStore, type CustomBubbleColors } from "@/store/settingsStore";

type ThemeMode = "light" | "dark";

interface ThemeState {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      themeMode: "light",
      setThemeMode: (mode) => set({ themeMode: mode }),
      toggleTheme: () => set({ themeMode: get().themeMode === "light" ? "dark" : "light" }),
    }),
    {
      name: "theme_mode",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ themeMode: state.themeMode }),
    }
  )
);

/** 获取当前模式对应的自定义颜色 */
export function useCurrentCustomColors(): CustomBubbleColors {
  const mode = useThemeStore((s) => s.themeMode);
  return useSettingsStore((s) => mode === "light" ? s.customColorsLight : s.customColorsDark);
}

/** 获取当前主题色板（合并自定义颜色） */
export function useTheme(): ColorPalette {
  const mode = useThemeStore((s) => s.themeMode);
  const base = mode === "dark" ? darkColors : lightColors;
  const custom = useCurrentCustomColors();

  return {
    ...base,
    bubbleUser: custom.bubbleUserBg || base.bubbleUser,
    textOnAccent: custom.bubbleUserText || base.textOnAccent,
    bubbleAi: custom.bubbleAiBg || base.bubbleAi,
  };
}

/** 非组件内获取当前色板 */
export function getThemeColors(): ColorPalette {
  const mode = useThemeStore.getState().themeMode;
  const base = mode === "dark" ? darkColors : lightColors;
  const custom = mode === "light"
    ? useSettingsStore.getState().customColorsLight
    : useSettingsStore.getState().customColorsDark;

  return {
    ...base,
    bubbleUser: custom.bubbleUserBg || base.bubbleUser,
    textOnAccent: custom.bubbleUserText || base.textOnAccent,
    bubbleAi: custom.bubbleAiBg || base.bubbleAi,
  };
}
