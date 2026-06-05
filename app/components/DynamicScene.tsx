import React, { useEffect, useRef } from 'react';
import { StyleSheet, Animated as RNAnimated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { getSceneConfig } from '../constants/scenes';
import { useHomeStore } from '../stores/home';

export function DynamicScene() {
  const { timeOfDay, weatherText } = useHomeStore();
  const fadeAnim = useRef(new RNAnimated.Value(1)).current;
  const scene = getSceneConfig(timeOfDay, weatherText);

  // 场景切换时淡入淡出
  useEffect(() => {
    RNAnimated.sequence([
      RNAnimated.timing(fadeAnim, { toValue: 0, duration: 500, useNativeDriver: true }),
      RNAnimated.timing(fadeAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
    ]).start();
  }, [timeOfDay, weatherText]);

  return (
    <RNAnimated.View style={[styles.container, { opacity: fadeAnim }]}>
      <LinearGradient
        colors={scene.gradient}
        style={styles.gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
      />
    </RNAnimated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
  },
  gradient: {
    flex: 1,
  },
});
