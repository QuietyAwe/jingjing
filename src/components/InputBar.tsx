import { useRef, useState, type RefObject } from "react";
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  Keyboard,
} from "react-native";
import { useTheme } from "@/theme/useTheme";

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  /** 点击右侧 + 按钮（开始游戏等） */
  onPlus?: () => void;
  /** 游戏进行中时隐藏 +，避免重复开局 */
  hidePlus?: boolean;
  /** 外部聚焦输入框用（AI 回复完成后自动弹起键盘） */
  inputRef?: RefObject<TextInput | null>;
}

export function InputBar({ onSend, disabled, onPlus, hidePlus, inputRef }: Props) {
  const [text, setText] = useState("");
  const colors = useTheme();

  // 同帧双击防抖：disabled 由父级 isLoading 异步生效，发送瞬间要自己挡住一次
  const sendingRef = useRef(false);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || sendingRef.current) return;
    sendingRef.current = true;
    onSend(trimmed);
    setText("");
    Keyboard.dismiss();
    // 兜底释放：覆盖父级 loading 尚未置位的短窗口；之后由 disabled 接管
    setTimeout(() => {
      sendingRef.current = false;
    }, 300);
  };

  return (
    <View style={[styles.container, { borderTopColor: colors.border, backgroundColor: colors.sectionBg }]}>
      <TextInput
        ref={inputRef}
        style={[styles.input, { backgroundColor: colors.inputBg, color: colors.text }]}
        value={text}
        onChangeText={setText}
        placeholder="说点什么..."
        placeholderTextColor={colors.placeholder}
        multiline
        maxLength={2000}
        // AI 回复期间也允许打字（可预输入），只禁发送按钮
        editable
        onSubmitEditing={handleSend}
        returnKeyType="send"
      />
      {onPlus && !hidePlus ? (
        <TouchableOpacity
          style={[styles.plusButton, { borderColor: colors.border }]}
          onPress={onPlus}
          disabled={disabled}
        >
          <Text style={[styles.plusText, { color: colors.textMuted }]}>+</Text>
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity
        style={[
          styles.button,
          { backgroundColor: colors.accent },
          (!text.trim() || disabled) && { backgroundColor: colors.btnDisabled },
        ]}
        onPress={handleSend}
        disabled={!text.trim() || disabled}
      >
        <Text style={[styles.buttonText, { color: colors.textOnAccent }]}>发送</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    lineHeight: 22,
  },
  button: {
    marginLeft: 10,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: "600",
  },
  plusButton: {
    marginLeft: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  plusText: {
    fontSize: 22,
    lineHeight: 24,
  },
});
