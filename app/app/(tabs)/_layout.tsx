import { Tabs } from 'expo-router';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#0f0f1a',
          borderTopColor: 'rgba(255,255,255,0.05)',
          height: 60,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: '#e67e22',
        tabBarInactiveTintColor: '#5a5a7a',
        tabBarLabelStyle: { fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: '首页', tabBarLabel: '听雨' }}
      />
      <Tabs.Screen
        name="diary"
        options={{ title: '动态', tabBarLabel: '动态' }}
      />
      <Tabs.Screen
        name="cowatch"
        options={{ title: '陪伴', tabBarLabel: '陪伴' }}
      />
      <Tabs.Screen
        name="timeline"
        options={{ title: '时空', tabBarLabel: '时空' }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: '设置', tabBarLabel: '设置' }}
      />
      <Tabs.Screen
        name="sleep-guard"
        options={{ href: null }} // 隐藏 Tab，通过月亮按钮导航
      />
    </Tabs>
  );
}
