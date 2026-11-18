import { useEffect, useState } from "react";
import { AccessibilityInfo, Easing } from "react-native";

export const MOTION = {
  enterDuration: 200,
  enterDistance: 4,
  easing: Easing.out(Easing.cubic),
} as const;

/** 跟随系统“减少动态效果”，循环动画必须停止。 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduced(value);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
