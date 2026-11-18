import { useSyncExternalStore } from "react";
import { AccessibilityInfo, Easing } from "react-native";

export const MOTION = {
  enterDuration: 200,
  enterDistance: 4,
  easing: Easing.out(Easing.cubic),
} as const;

let reducedMotion = false;
let subscribed = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  AccessibilityInfo.isReduceMotionEnabled()
    .then((value) => {
      if (value === reducedMotion) return;
      reducedMotion = value;
      emit();
    })
    .catch(() => {});
  AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
    if (value === reducedMotion) return;
    reducedMotion = value;
    emit();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureSubscribed();
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return reducedMotion;
}

/** 全 App 共用一个系统监听，避免进入聊天页时每条气泡各注册一次。 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
