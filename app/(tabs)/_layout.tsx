import { Tabs } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/theme/useTheme";
import { useUnreadStore } from "@/store/unreadStore";

export default function TabLayout() {
  const colors = useTheme();
  const momentsUnread = useUnreadStore((s) => s.momentsUnread);

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.sectionBg },
        headerTitleStyle: { color: colors.text, fontSize: 17, fontWeight: "600" },
        headerShadowVisible: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "500" },
        tabBarStyle: {
          borderTopColor: colors.border,
          borderTopWidth: 0.5,
          backgroundColor: colors.sectionBg,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "私藏",
          headerShown: false,
          tabBarAccessibilityLabel: "私藏会话",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "chatbubble-ellipses" : "chatbubble-ellipses-outline"} color={color} size={22} />
          ),
        }}
      />
      <Tabs.Screen
        name="moments"
        options={{
          title: "动态",
          headerShown: false,
          tabBarAccessibilityLabel: momentsUnread ? "心情动态，有新内容" : "心情动态",
          tabBarBadge: momentsUnread ? "新" : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.accent, color: colors.accentText, fontSize: 9 },
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "partly-sunny" : "partly-sunny-outline"} color={color} size={23} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "设置",
          headerTitle: "设置",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? "settings" : "settings-outline"} color={color} size={22} />
          ),
        }}
      />
    </Tabs>
  );
}
