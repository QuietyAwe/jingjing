import { useState } from "react";
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
}

export function InputBar({ onSend, disabled }: Props) {
  const [text, setText] = useState("");
  const colors = useTheme();

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    Keyboard.dismiss();
  };

  return (
    <View style={[styles.container, { borderTopColor: colors.border, backgroundColor: colors.sectionBg }]}>
      <TextInput
        style={[styles.input, { backgroundColor: colors.inputBg, color: colors.text }]}
        value={text}
        onChangeText={setText}
        placeholder="说点什么..."
        placeholderTextColor={colors.placeholder}
        multiline
        maxLength={2000}
        editable={!disabled}
        onSubmitEditing={handleSend}
        returnKeyType="send"
      />
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
});
