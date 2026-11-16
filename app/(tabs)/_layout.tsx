import { Tabs } from "expo-router";
import { Text } from "react-native";
import { useTheme } from "@/theme/useTheme";
import { useUnreadStore } from "@/store/unreadStore";

export default function TabLayout() {
  const colors = useTheme();
  const momentsUnread = useUnreadStore((s) => s.momentsUnread);

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.sectionBg },
        headerTitleStyle: { color: colors.text, fontWeight: "600" },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          borderTopColor: colors.border,
          backgroundColor: colors.sectionBg,
        },
        tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>●</Text>,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "私藏",
          headerShown: false,
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 17 }}>💬</Text>,
        }}
      />
      <Tabs.Screen
        name="moments"
        options={{
          title: "动态",
          headerShown: false,
          tabBarBadge: momentsUnread ? "新" : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.accent, fontSize: 10 },
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 17 }}>🌤</Text>,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "设置",
          headerTitle: "设置",
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 17 }}>⚙️</Text>,
        }}
      />
    </Tabs>
  );
}
