import { Tabs } from "expo-router";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: "#FFFFFF" },
        headerTitleStyle: { color: "#37352F", fontWeight: "600" },
        tabBarActiveTintColor: "#2F81F7",
        tabBarInactiveTintColor: "#9B9A97",
        tabBarStyle: {
          borderTopColor: "#E8E7E4",
          backgroundColor: "#FFFFFF",
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "私藏",
          headerTitle: "私藏",
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
