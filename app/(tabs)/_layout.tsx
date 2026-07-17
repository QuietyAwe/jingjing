import { Tabs } from "expo-router";
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
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "私藏",
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "设置",
          headerTitle: "设置",
        }}
      />
    </Tabs>
  );
}
