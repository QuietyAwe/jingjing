import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { initSchema } from "@/db/schema";
import { useMetaStore } from "@/store/metaStore";
import { startDreaming } from "@/memory/dreaming";
import { loadConfigOverrides } from "@/prompt/config";

// App 启动时初始化数据库表结构
initSchema();

// 冷启动重置锁 — 对齐 PRD 3.2 节持久化死锁兜底
useMetaStore.getState().load();
useMetaStore.getState().setLocked(false);

// 加载自定义配置覆盖
loadConfigOverrides();

// 启动做梦流闲置监听
startDreaming();

export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
