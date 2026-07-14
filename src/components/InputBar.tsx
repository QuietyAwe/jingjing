import { useState } from "react";
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  Keyboard,
} from "react-native";

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function InputBar({ onSend, disabled }: Props) {
  const [text, setText] = useState("");

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    Keyboard.dismiss();
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="说点什么..."
        placeholderTextColor="#B0AFAF"
        multiline
        maxLength={2000}
        editable={!disabled}
        onSubmitEditing={handleSend}
        returnKeyType="send"
      />
      <TouchableOpacity
        style={[styles.button, (!text.trim() || disabled) && styles.buttonDisabled]}
        onPress={handleSend}
        disabled={!text.trim() || disabled}
      >
        <Text style={styles.buttonText}>发送</Text>
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
    borderTopColor: "#E8E7E4",
    backgroundColor: "#FFFFFF",
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    backgroundColor: "#F7F7F5",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: "#37352F",
    lineHeight: 22,
  },
  button: {
    marginLeft: 10,
    backgroundColor: "#2F81F7",
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  buttonDisabled: {
    backgroundColor: "#D3D1CB",
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
});
