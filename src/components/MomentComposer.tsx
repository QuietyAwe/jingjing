import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Modal,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useTheme } from "@/theme/useTheme";
import { MOOD_TAGS, MOOD_COLORS, type MoodTag } from "@/types/schema";

interface Props {
  visible: boolean;
  onClose: () => void;
  onSubmit: (content: string, mood: MoodTag) => void;
}

/**
 * 发帖浮层：底部上滑 Modal —— 心情标签单选胶囊 + 多行输入 + 发布
 */
export function MomentComposer({ visible, onClose, onSubmit }: Props) {
  const colors = useTheme();
  const [content, setContent] = useState("");
  const [mood, setMood] = useState<MoodTag>("平静");

  const canPublish = content.trim().length > 0;

  const close = () => {
    setContent("");
    setMood("平静");
    onClose();
  };

  const publish = () => {
    if (!canPublish) return;
    onSubmit(content.trim(), mood);
    close();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <TouchableWithoutFeedback onPress={close}>
        <View style={[styles.backdrop, { backgroundColor: colors.overlayBg }]} />
      </TouchableWithoutFeedback>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheetWrap}
        pointerEvents="box-none"
      >
        <View style={[styles.sheet, { backgroundColor: colors.sectionBg }]}>
          <Text style={[styles.title, { color: colors.text }]}>发条动态</Text>

          {/* 心情标签胶囊 */}
          <View style={styles.moodRow}>
            {MOOD_TAGS.map((tag) => {
              const selected = tag === mood;
              return (
                <TouchableOpacity
                  key={tag}
                  onPress={() => setMood(tag)}
                  style={[
                    styles.moodPill,
                    {
                      backgroundColor: selected ? colors.accentMuted : colors.inputBg,
                      borderColor: selected ? MOOD_COLORS[tag] : colors.border,
                    },
                  ]}
                >
                  <View style={[styles.moodDot, { backgroundColor: MOOD_COLORS[tag] }]} />
                  <Text
                    style={[
                      styles.moodPillText,
                      { color: selected ? MOOD_COLORS[tag] : colors.textMuted },
                    ]}
                  >
                    {tag}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TextInput
            style={[styles.input, { backgroundColor: colors.inputBg, color: colors.text }]}
            value={content}
            onChangeText={setContent}
            placeholder="此刻的心情…"
            placeholderTextColor={colors.placeholder}
            multiline
            maxLength={300}
            autoFocus
          />

          <View style={styles.actions}>
            <TouchableOpacity onPress={close} style={styles.cancelBtn}>
              <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={publish}
              disabled={!canPublish}
              style={[
                styles.publishBtn,
                { backgroundColor: canPublish ? colors.accent : colors.btnDisabled },
              ]}
            >
              <Text style={styles.publishText}>发布</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
  },
  sheetWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 18,
    paddingBottom: 32,
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    marginBottom: 14,
  },
  moodRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 12,
  },
  moodPill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginRight: 8,
    marginBottom: 8,
  },
  moodDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: 5,
  },
  moodPillText: {
    fontSize: 13,
    fontWeight: "500",
  },
  input: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    lineHeight: 22,
    minHeight: 96,
    textAlignVertical: "top",
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    marginTop: 14,
  },
  cancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  cancelText: {
    fontSize: 15,
  },
  publishBtn: {
    borderRadius: 18,
    paddingVertical: 9,
    paddingHorizontal: 22,
    marginLeft: 10,
  },
  publishText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
});
