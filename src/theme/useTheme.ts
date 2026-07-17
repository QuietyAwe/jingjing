// ============================================================
// 主题管理 — Zustand store + useTheme hook
// ============================================================

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { lightColors, darkColors, type ColorPalette } from "./colors";

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

/** 获取当前主题色板 */
export function useTheme(): ColorPalette {
  const mode = useThemeStore((s) => s.themeMode);
  return mode === "dark" ? darkColors : lightColors;
}

/** 非组件内获取当前色板 */
export function getThemeColors(): ColorPalette {
  return useThemeStore.getState().themeMode === "dark" ? darkColors : lightColors;
}
