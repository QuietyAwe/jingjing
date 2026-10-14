// ============================================================
// 系统元数据 store（turn_counter + is_locked）
// 对齐 PRD 2.2 节计数与锁机制
// ============================================================

import { create } from "zustand";
import { getMeta, setMeta } from "@/db/queries";

interface MetaState {
  turnCounter: number;
  isLocked: boolean;

  /** 从数据库加载状态 */
  load: () => void;
  /** 回复成功后累加计数 */
  incrementTurn: () => void;
  /** 重置计数与锁 */
  reset: () => void;
  /** 设置锁 */
  setLocked: (locked: boolean) => void;
}

// 进程内只强制清锁一次（防上次崩溃死锁）。load 会在聊天页每次挂载时执行，
// 无条件清锁会把进行中的巩固的锁误释放，导致并发巩固互相覆盖游标与计数
let startupLockCleared = false;

export const useMetaStore = create<MetaState>((set, get) => ({
  turnCounter: 0,
  isLocked: false,

  load: () => {
    const counter = getMeta("turn_counter");
    if (!startupLockCleared) {
      startupLockCleared = true;
      setMeta("is_locked", "false");
    }
    set({
      turnCounter: counter ? parseInt(counter, 10) : 0,
      isLocked: getMeta("is_locked") === "true",
    });
  },

  incrementTurn: () => {
    const next = get().turnCounter + 1;
    setMeta("turn_counter", String(next));
    set({ turnCounter: next });
  },

  reset: () => {
    setMeta("turn_counter", "0");
    setMeta("is_locked", "false");
    set({ turnCounter: 0, isLocked: false });
  },

  setLocked: (locked) => {
    setMeta("is_locked", String(locked));
    set({ isLocked: locked });
  },
}));
