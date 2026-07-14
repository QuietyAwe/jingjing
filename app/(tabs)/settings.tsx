import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { useSettingsStore } from "@/store/settingsStore";
import { useChatStore } from "@/store/chatStore";
import AsyncStorage from "@react-native-async-storage/async-storage";

export default function SettingsScreen() {
  const { apiKey } = useSettingsStore();
  const clearMessages = useChatStore((s) => s.clearMessages);

  const handleChangeKey = async () => {
    await AsyncStorage.removeItem("openai_api_key");
    useSettingsStore.setState({ apiKey: "", isReady: true });
  };

  const handleClearData = () => {
    Alert.alert("清除所有数据", "确定要清除所有聊天记录和记忆数据吗？", [
      { text: "取消", style: "cancel" },
      {
        text: "确认清除",
        style: "destructive",
        onPress: () => {
          clearMessages();
          Alert.alert("已清除", "聊天记录已清除。重启 App 以重置数据库。");
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>API</Text>
        <View style={styles.row}>
          <Text style={styles.label}>API Key</Text>
          <Text style={styles.value}>
            {apiKey ? `${apiKey.slice(0, 8)}...` : "未设置"}
          </Text>
        </View>
        <TouchableOpacity style={styles.actionRow} onPress={handleChangeKey}>
          <Text style={styles.actionText}>更换 API Key</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>数据</Text>
        <TouchableOpacity style={styles.actionRow} onPress={handleClearData}>
          <Text style={[styles.actionText, { color: "#E03E3E" }]}>
            清除所有数据
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F7F7F5",
    paddingTop: 8,
  },
  section: {
    backgroundColor: "#FFFFFF",
    marginBottom: 16,
    paddingHorizontal: 20,
    paddingVertical: 4,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "#9B9A97",
    textTransform: "uppercase",
    letterSpacing: 1,
    paddingVertical: 12,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E8E7E4",
  },
  label: {
    fontSize: 15,
    color: "#37352F",
  },
  value: {
    fontSize: 14,
    color: "#9B9A97",
  },
  actionRow: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E8E7E4",
  },
  actionText: {
    fontSize: 15,
    color: "#2F81F7",
  },
});
