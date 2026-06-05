import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Animated as RNAnimated } from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useHomeStore } from '../../stores/home';
import { useOnboardingStore } from '../../stores/onboarding';
import { getWeather } from '../../services/weather';
import { DynamicScene } from '../../components/DynamicScene';
import { StatusText } from '../../components/StatusText';
import { AmbientAudio, AmbientAudioRef } from '../../components/AmbientAudio';
import { InputBar } from '../../components/InputBar';
import { MoonButton } from '../../components/MoonButton';
import { ChatDrawer } from '../../components/ChatDrawer';

const LAST_OPEN_KEY = 'last_open_timestamp';

export default function HomeScreen() {
  const { callName } = useOnboardingStore();
  const { setWeather, setReturningUser } = useHomeStore();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const fadeInAnim = useRef(new RNAnimated.Value(0)).current;
  const ambientRef = useRef<AmbientAudioRef>(null);

  useEffect(() => {
    initHome();
  }, []);

  const initHome = async () => {
    // 回归检测
    try {
      const lastOpen = await AsyncStorage.getItem(LAST_OPEN_KEY);
      if (lastOpen) {
        const elapsed = Date.now() - parseInt(lastOpen, 10);
        if (elapsed > 24 * 60 * 60 * 1000) {
          setReturningUser(true);
        }
      }
      await AsyncStorage.setItem(LAST_OPEN_KEY, Date.now().toString());
    } catch (e) {
      // AsyncStorage 不可用时静默失败
    }

    // 获取天气数据
    try {
      const weather = await getWeather();
      setWeather(weather.time_of_day, weather.weather_text);
    } catch (e) {
      console.log('Weather API unavailable, using defaults');
    }

    // 淡入动画
    RNAnimated.timing(fadeInAnim, {
      toValue: 1,
      duration: 2000,
      useNativeDriver: true,
    }).start();
  };

  // 底噪压制（TTS 播放时）
  const handleAmbientDuck = (duck: boolean) => {
    ambientRef.current?.duck(duck);
  };

  return (
    <View style={styles.container}>
      {/* 全屏动态场景背景 */}
      <DynamicScene />

      {/* 中心状态文字 */}
      <View style={styles.statusContainer}>
        <StatusText />
      </View>

      {/* 环境音场引擎（无 UI） */}
      <AmbientAudio ref={ambientRef} />

      {/* 月亮按钮 */}
      <MoonButton onPress={() => router.push('/(tabs)/sleep-guard')} />

      {/* 底部输入栏（点击打开聊天面板） */}
      {!isDrawerOpen && (
        <InputBar onPress={() => setIsDrawerOpen(true)} />
      )}

      {/* 聊天抽屉面板 */}
      <ChatDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        onAmbientDuck={handleAmbientDuck}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  statusContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 100,
  },
});
