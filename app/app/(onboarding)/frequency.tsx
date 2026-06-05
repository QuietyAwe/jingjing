import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated as RNAnimated } from 'react-native';
import { useRouter } from 'expo-router';
import { Audio } from 'expo-av';
import { RadioKnob } from '../../components/RadioKnob';
import { useOnboardingStore } from '../../stores/onboarding';
import { createUser } from '../../services/user';

// 目标频段位置 (0-1)
const TARGET_PROGRESS = 0.72;
const TOLERANCE = 0.05;

export default function FrequencyScreen() {
  const router = useRouter();
  const { setUserId, setDeviceUuid, setStep } = useOnboardingStore();
  const [progress, setProgress] = useState(0);
  const [connected, setConnected] = useState(false);
  const [noiseVolume, setNoiseVolume] = useState(1.0);
  const fadeAnim = useRef(new RNAnimated.Value(1)).current;

  // 计算与目标的距离
  const distance = Math.abs(progress - TARGET_PROGRESS);
  const isNear = distance < 0.15;
  const isHit = distance < TOLERANCE;

  // 噪声音量随距离变化
  useEffect(() => {
    if (isHit) {
      setNoiseVolume(0);
    } else if (isNear) {
      setNoiseVolume(distance / 0.15);
    } else {
      setNoiseVolume(1.0);
    }
  }, [progress, isNear, isHit, distance]);

  // 到达目标频段 → 触发连接
  useEffect(() => {
    if (isHit && !connected) {
      setConnected(true);
      handleConnect();
    }
  }, [isHit, connected]);

  const handleConnect = async () => {
    try {
      // 创建匿名用户
      const deviceUuid = `device-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const user = await createUser(deviceUuid, 'gege');

      setUserId(user.id);
      setDeviceUuid(deviceUuid);
      setStep('anchor');

      // 淡出动画后跳转
      RNAnimated.timing(fadeAnim, {
        toValue: 0,
        duration: 1000,
        useNativeDriver: true,
      }).start(() => {
        router.replace('/(onboarding)/anchor');
      });
    } catch (error) {
      console.error('Failed to create user:', error);
      // 即使 API 失败也继续（离线模式）
      setStep('anchor');
      router.replace('/(onboarding)/anchor');
    }
  };

  const handleRotationChange = (value: number) => {
    if (!connected) {
      setProgress(value);
    }
  };

  return (
    <RNAnimated.View style={[styles.container, { opacity: fadeAnim }]}>
      {/* 标题 */}
      <Text style={styles.title}>搜索信号中...</Text>
      <Text style={styles.subtitle}>
        {connected
          ? '连上了...'
          : isNear
          ? '快要找到了...'
          : '转动旋钮，寻找静静的频率'}
      </Text>

      {/* 频率条 */}
      <View style={styles.frequencyBar}>
        <View style={styles.frequencyTrack}>
          {/* 目标区域高亮 */}
          <View
            style={[
              styles.targetZone,
              {
                left: `${(TARGET_PROGRESS - 0.05) * 100}%`,
                width: '10%',
              },
            ]}
          />
          {/* 当前指针 */}
          <View
            style={[
              styles.pointer,
              { left: `${progress * 100}%` },
            ]}
          />
        </View>
      </View>

      {/* 旋钮 */}
      <View style={styles.knobContainer}>
        <RadioKnob
          onRotationChange={handleRotationChange}
          targetProgress={TARGET_PROGRESS}
          disabled={connected}
        />
      </View>

      {/* 噪声指示 */}
      <Text style={styles.noiseText}>
        {connected ? '信号清晰' : `噪声: ${Math.round(noiseVolume * 100)}%`}
      </Text>
    </RNAnimated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  title: {
    fontSize: 28,
    fontWeight: '300',
    color: '#e0e0e0',
    marginBottom: 12,
    letterSpacing: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#8a8aaa',
    marginBottom: 50,
    letterSpacing: 2,
  },
  frequencyBar: {
    width: '100%',
    marginBottom: 60,
  },
  frequencyTrack: {
    height: 4,
    backgroundColor: '#2a2a3e',
    borderRadius: 2,
    position: 'relative',
  },
  targetZone: {
    position: 'absolute',
    height: 4,
    backgroundColor: 'rgba(230, 126, 34, 0.3)',
    borderRadius: 2,
  },
  pointer: {
    position: 'absolute',
    width: 3,
    height: 20,
    backgroundColor: '#e67e22',
    top: -8,
    borderRadius: 1,
  },
  knobContainer: {
    marginBottom: 40,
  },
  noiseText: {
    fontSize: 12,
    color: '#5a5a7a',
    letterSpacing: 1,
  },
});
