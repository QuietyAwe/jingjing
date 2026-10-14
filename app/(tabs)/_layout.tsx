import { Tabs } from "expo-router";
import { Text } from "react-native";
import { useTheme } from "@/theme/useTheme";

export default function TabLayout() {
  const colors = useTheme();

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
