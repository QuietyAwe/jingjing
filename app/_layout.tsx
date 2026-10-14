import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { initSchema } from "@/db/schema";
import { mergeEpisodeDuplicates } from "@/db/queries";
import { useMetaStore } from "@/store/metaStore";
import { useSettingsStore } from "@/store/settingsStore";
import { loadConfigOverrides } from "@/prompt/config";
import { runCatchUpConsolidation } from "@/memory/consolidation";
import { useThemeStore, getThemeColors } from "@/theme/useTheme";
import { useMomentsEngine } from "@/moments/engine";

// App 启动时初始化数据库表结构
initSchema();

// 自愈历史数据：同名 episode 事件合并（早期版本每次对局都新建事件）
mergeEpisodeDuplicates();

// 冷启动重置锁 — 对齐 PRD 3.2 节持久化死锁兜底
useMetaStore.getState().load();
useMetaStore.getState().setLocked(false);

// 加载自定义配置覆盖
loadConfigOverrides();

// 补巩固提前到 App 启动就跑（一次性守卫在 runCatchUpConsolidation 内部）：
// 等到进聊天页再跑会和用户的新消息赛跑——补巩固每批一次 LLM、要跑好几批，
// 越晚开始越容易把刚发的消息卷进批次
useSettingsStore
  .getState()
  .loadApiKey()
  .then(() => runCatchUpConsolidation())
  .catch((err) => console.error("[app] 启动补巩固异常:", err));

export default function RootLayout() {
  const { themeMode } = useThemeStore();
  const isDark = themeMode === "dark";
  const colors = getThemeColors();

  // 心情动态引擎：全局发帖调度（60s 轮询），与所在页面无关
  useMomentsEngine();

  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </>
  );
}
