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

export const useMetaStore = create<MetaState>((set, get) => ({
  turnCounter: 0,
  isLocked: false,

  load: () => {
    const counter = getMeta("turn_counter");
    const locked = getMeta("is_locked");
    set({
      turnCounter: counter ? parseInt(counter, 10) : 0,
      isLocked: locked === "true",
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
