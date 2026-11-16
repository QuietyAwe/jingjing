// ============================================================
// 未读态（动态 Tab 角标）
//
// 首页与动态页刷新时更新；Tabs 布局订阅它显示角标。
// ============================================================

import { create } from "zustand";

interface UnreadState {
  momentsUnread: boolean;
  setMomentsUnread: (v: boolean) => void;
}

export const useUnreadStore = create<UnreadState>((set) => ({
  momentsUnread: false,
  setMomentsUnread: (v) => set({ momentsUnread: v }),
}));
