import { useEffect } from "react";
import { AppState } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { initSchema } from "@/db/schema";
import { mergeEpisodeDuplicates } from "@/db/queries";
import { useMetaStore } from "@/store/metaStore";
import { useChatStore } from "@/store/chatStore";
import { useSettingsStore } from "@/store/settingsStore";
import { loadConfigOverrides } from "@/prompt/config";
import { hasApiKey } from "@/llm/client";
import { shouldConsolidate, runConsolidation } from "@/memory/consolidation";
import { useThemeStore, getThemeColors } from "@/theme/useTheme";
import { useMomentsEngine } from "@/moments/engine";

// App 启动时初始化数据库表结构
initSchema();

// 自愈历史数据：同名 episode 事件合并（早期版本每次对局都新建事件）
mergeEpisodeDuplicates();

// 冷启动重置锁 — 对齐 PRD 3.2 节持久化死锁兜底
useMetaStore.getState().load();
useMetaStore.getState().setLocked(false);

/**
 * 启动初始化：配置覆盖 → API Key → 首次巩固判定
 *
 * 顺序有意义：阈值覆盖没进内存时 `getThresholds()` 会返回 defaultConfig 的值，
 * 判定会按默认的 10k / 30 分钟算，用户改过的参数不生效。
 */
async function bootstrap() {
  await loadConfigOverrides().catch((err) =>
    console.error("[app] 配置加载异常:", err)
  );
  await useSettingsStore
    .getState()
    .loadApiKey()
    .catch((err) => console.error("[app] 配置加载异常:", err));

  // 启动判定与「回到前台」完全一致：条件全交给 shouldConsolidate
  // （最少 10 轮 + 未巩固 ≥ token 预算或空闲 ≥ 阈值），不另写一套
  const check = () => {
    if (!hasApiKey()) return;
    const messages = useChatStore.getState().messages;
    if (shouldConsolidate(messages, { checkIdle: true })) {
      runConsolidation(messages).catch((err) =>
        console.error("[app] 启动巩固异常:", err)
      );
    }
  };

  // 消息从 AsyncStorage 异步恢复：早于水合读到的 messages 是空数组
  if (useChatStore.persist.hasHydrated()) check();
  else useChatStore.persist.onFinishHydration(check);
}

bootstrap();

export default function RootLayout() {
  const { themeMode } = useThemeStore();
  const isDark = themeMode === "dark";
  const colors = getThemeColors();

  // 心情动态引擎：全局发帖调度（60s 轮询），与所在页面无关
  useMomentsEngine();

  // 回到前台时补一次空闲触发的巩固：手机端没有可靠后台，只能在事件点检查
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (!hasApiKey()) return;
      const messages = useChatStore.getState().messages;
      if (shouldConsolidate(messages, { checkIdle: true })) {
        runConsolidation(messages).catch((err) =>
          console.error("[app] 前台巩固异常:", err),
        );
      }
    });
    return () => sub.remove();
  }, []);

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
