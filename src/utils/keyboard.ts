import { useEffect, useState } from "react";
import { Keyboard, LayoutAnimation, Platform, UIManager } from "react-native";

const KEYBOARD_LAYOUT_MS = 200;

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

function animateKeyboardLayout(): void {
  LayoutAnimation.configureNext({
    duration: KEYBOARD_LAYOUT_MS,
    update: { type: LayoutAnimation.Types.easeInEaseOut },
  });
}

/**
 * Android 的键盘高度。
 *
 * 部分 Android 窗口不会随键盘 resize，必须手动把底栏顶上去。
 * 展开和收起都走 200ms 布局缓动，停下后显式归零，不依赖键盘避让组件。
 */
export function useAndroidKeyboardHeight(): number {
  const [height, setHeight] = useState(() =>
    Platform.OS === "android" ? Keyboard.metrics()?.height ?? 0 : 0
  );

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      animateKeyboardLayout();
      setHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      animateKeyboardLayout();
      setHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return Platform.OS === "android" ? height : 0;
}
