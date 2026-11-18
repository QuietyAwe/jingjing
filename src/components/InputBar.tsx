import { useRef, useState, type RefObject } from "react";
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  Keyboard,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
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
  const sendingRef = useRef(false);
  const sendDisabled = !text.trim() || disabled;

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || sendingRef.current) return;
    // 同帧双击先由本地状态挡住，之后由父级 disabled 接管。
    sendingRef.current = true;
    onSend(trimmed);
    setText("");
    Keyboard.dismiss();
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
        placeholder="说点什么…"
        placeholderTextColor={colors.placeholder}
        accessibilityLabel="消息输入框"
        multiline
        maxLength={2000}
        editable
        onSubmitEditing={handleSend}
        returnKeyType="send"
      />
      {onPlus && !hidePlus ? (
        <TouchableOpacity
          style={[styles.plusButton, { backgroundColor: colors.inputBg, opacity: disabled ? 0.45 : 1 }]}
          onPress={onPlus}
          disabled={disabled}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="打开游戏菜单"
          accessibilityState={{ disabled: !!disabled }}
        >
          <Ionicons name="add" size={25} color={colors.textSecondary} />
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity
        style={[
          styles.button,
          { backgroundColor: sendDisabled ? colors.btnBg : colors.accent },
        ]}
        onPress={handleSend}
        disabled={sendDisabled}
        activeOpacity={0.78}
        accessibilityRole="button"
        accessibilityLabel={disabled ? "等待回复，暂时不能发送" : "发送消息"}
        accessibilityState={{ disabled: !!sendDisabled }}
      >
        <Text style={[styles.buttonText, { color: sendDisabled ? colors.textMuted : colors.accentText }]}>发送</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    lineHeight: 22,
  },
  button: {
    marginLeft: 8,
    minHeight: 44,
    justifyContent: "center",
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: "600",
  },
  plusButton: {
    marginLeft: 8,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
});
