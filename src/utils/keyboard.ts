import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * Android 的键盘高度。
 *
 * 部分 Android 窗口不会随键盘 resize，必须手动把底栏顶上去。
 * 收起事件里显式归零，不能依赖键盘避让组件的内部状态。
 */
export function useAndroidKeyboardHeight(): number {
  const [height, setHeight] = useState(() =>
    Platform.OS === "android" ? Keyboard.metrics()?.height ?? 0 : 0
  );

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      setHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return Platform.OS === "android" ? height : 0;
}
