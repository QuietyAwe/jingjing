import React, { useEffect, useRef, useState } from 'react';
import { Text, StyleSheet, Animated as RNAnimated } from 'react-native';
import { getSceneConfig, FALLBACK_TEXTS } from '../constants/scenes';
import { useHomeStore } from '../stores/home';

// 随机间隔 30-90 秒
const MIN_INTERVAL = 30000;
const MAX_INTERVAL = 90000;

function getRandomInterval(): number {
  return MIN_INTERVAL + Math.random() * (MAX_INTERVAL - MIN_INTERVAL);
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function StatusText() {
  const { timeOfDay, weatherText, isReturningUser } = useHomeStore();
  const [text, setText] = useState('静静在窗边等你...');
  const fadeAnim = useRef(new RNAnimated.Value(1)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 回归检测：首次显示特殊文案，10 秒后切换
  useEffect(() => {
    if (isReturningUser) {
      setText('好久没见到哥哥了...静静好想你...');
      const timer = setTimeout(() => {
        switchText();
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [isReturningUser]);

  // 定时切换文案
  useEffect(() => {
    if (isReturningUser) return; // 回归文案显示期间不切换

    const scheduleNext = () => {
      timerRef.current = setTimeout(() => {
        switchText();
        scheduleNext();
      }, getRandomInterval());
    };

    scheduleNext();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [timeOfDay, weatherText, isReturningUser]);

  const switchText = () => {
    const scene = getSceneConfig(timeOfDay, weatherText);
    const pool = [...scene.statusTexts, ...FALLBACK_TEXTS];
    const newText = pickRandom(pool);

    // 淡出 → 换文字 → 淡入
    RNAnimated.sequence([
      RNAnimated.timing(fadeAnim, { toValue: 0, duration: 800, useNativeDriver: true }),
      RNAnimated.timing(fadeAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
    ]).start();

    // 在淡出完成时切换文字
    setTimeout(() => setText(newText), 800);
  };

  return (
    <RNAnimated.Text style={[styles.text, { opacity: fadeAnim }]}>
      {text}
    </RNAnimated.Text>
  );
}

const styles = StyleSheet.create({
  text: {
    fontSize: 16,
    color: 'rgba(255, 255, 255, 0.7)',
    letterSpacing: 2,
    textAlign: 'center',
    fontWeight: '300',
  },
});
