import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Keyboard, Platform } from "react-native";

/** 留白缓动时长：略短于键盘自身动画，收尾不拖沓 */
const LIFT_MS = 180;

export interface AndroidKeyboard {
  /** 当前键盘高度（0 = 收起）：给底栏安全区这类二选一判断用 */
  height: number;
  /** 缓动后的底部留白：直接挂到容器 paddingBottom 上 */
  pad: Animated.Value;
}

/**
 * Android 的键盘留白。
 *
 * 部分 Android 窗口不会随键盘 resize，必须手动把底栏顶上去。
 * 键盘事件要等完全展开/收起才到达，留白走 180ms 缓动补上，
 * 底栏跟着滑上去而不是瞬间错位。
 */
export function useAndroidKeyboard(): AndroidKeyboard {
  const initial = Platform.OS === "android" ? Keyboard.metrics()?.height ?? 0 : 0;
  const [height, setHeight] = useState(initial);
  const pad = useRef(new Animated.Value(initial)).current;

  useEffect(() => {
    if (Platform.OS !== "android") return;
    // padding 属于布局属性，只能走 JS 驱动的逐帧动画
    const slide = (to: number) =>
      Animated.timing(pad, {
        toValue: to,
        duration: LIFT_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start();
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      setHeight(event.endCoordinates.height);
      slide(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setHeight(0);
      slide(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [pad]);

  return { height, pad };
}
