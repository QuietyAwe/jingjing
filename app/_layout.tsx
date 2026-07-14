import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { initSchema } from "@/db/schema";
import { useMetaStore } from "@/store/metaStore";

// App 启动时初始化数据库表结构
initSchema();

// 冷启动重置锁 — 对齐 PRD 3.2 节持久化死锁兜底
useMetaStore.getState().load();
useMetaStore.getState().setLocked(false);

export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
