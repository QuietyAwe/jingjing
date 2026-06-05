import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated as RNAnimated,
  AppState,
  AppStateStatus,
} from 'react-native';
import { Audio } from 'expo-av';
import * as Brightness from 'expo-brightness';
import { useSleepStore } from '../../stores/sleep';
import { useOnboardingStore } from '../../stores/onboarding';
import { generateSleepAudio } from '../../services/sleep';
import type { SleepSegment } from '../../services/sleep';

// 定时选项
const TIMER_OPTIONS = [30, 60];

export default function SleepGuardScreen() {
  const { userId } = useOnboardingStore();
  const {
    mode,
    segments,
    currentIndex,
    elapsed,
    totalDuration,
    timerMinutes,
    timerRemaining,
    setMode,
    setSegments,
    setCurrentIndex,
    setElapsed,
    setTimerMinutes,
    setTimerRemaining,
    reset,
  } = useSleepStore();

  const soundRef = useRef<Audio.Sound | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);
  const fadeAnim = useRef(new RNAnimated.Value(0)).current;
  const moonGlow = useRef(new RNAnimated.Value(0.3)).current;
  const [showTimerPicker, setShowTimerPicker] = useState(false);

  // 初始化：生成音频
  useEffect(() => {
    if (mode === 'idle' && userId) {
      loadAudio();
    }
    return () => {
      cleanup();
    };
  }, []);

  // 月亮呼吸光效
  useEffect(() => {
    const glow = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(moonGlow, { toValue: 0.8, duration: 4000, useNativeDriver: true }),
        RNAnimated.timing(moonGlow, { toValue: 0.3, duration: 4000, useNativeDriver: true }),
      ]),
    );
    glow.start();
    return () => glow.stop();
  }, []);

  // 淡入动画
  useEffect(() => {
    RNAnimated.timing(fadeAnim, {
      toValue: 1,
      duration: 2000,
      useNativeDriver: true,
    }).start();
  }, []);

  // 屏幕常亮 + 低亮度
  useEffect(() => {
    const setupScreen = async () => {
      try {
        await Brightness.setBrightnessAsync(0.05); // 5% 亮度
      } catch {}
    };
    setupScreen();
    return () => {
      // 恢复亮度
      Brightness.requestPermissionsAsync().then(() => {
        Brightness.setBrightnessAsync(0.5);
      }).catch(() => {});
    };
  }, []);

  // 定时器
  useEffect(() => {
    if (mode === 'playing') {
      const totalSec = timerMinutes * 60;
      setTimerRemaining(totalSec);

      timerRef.current = setInterval(() => {
        const store = useSleepStore.getState();
        const remaining = store.timerRemaining - 1;
        if (remaining <= 0) {
          handleExit();
        } else {
          setTimerRemaining(remaining);
          setElapsed(store.elapsed + 1);
        }
      }, 1000);

      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
  }, [mode]);

  // 播放当前段落
  useEffect(() => {
    if (mode === 'playing' && currentIndex < segments.length) {
      playSegment(segments[currentIndex]);
    } else if (currentIndex >= segments.length && segments.length > 0) {
      setMode('finished');
    }
  }, [currentIndex, mode]);

  // App 状态监听（锁屏继续播放）
  useEffect(() => {
    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, []);

  const handleAppStateChange = (state: AppStateStatus) => {
    // 锁屏时继续播放（expo-av 已配置 staysActiveInBackground）
    // 回到前台时恢复低亮度
    if (state === 'active') {
      Brightness.setBrightnessAsync(0.05).catch(() => {});
    }
  };

  const loadAudio = async () => {
    setMode('loading');
    try {
      const data = await generateSleepAudio(userId!, 30);
      setSegments(data.segments, data.total_duration);
      setMode('playing');
    } catch (e) {
      console.error('[SleepGuard] Load failed:', e);
      // 使用 mock 数据
      setMode('playing');
    }
  };

  const playSegment = async (segment: SleepSegment) => {
    try {
      // 卸载旧音频
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }

      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
      });

      const uri = `data:audio/wav;base64,${segment.audio}`;
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        {
          shouldPlay: true,
          volume: segment.volume,
        },
        (status) => {
          if (status.isLoaded && status.didJustFinish) {
            setCurrentIndex(currentIndex + 1);
          }
        },
      );
      soundRef.current = sound;
    } catch (e) {
      console.error('[SleepGuard] Play error:', e);
      // 跳过失败的段落
      setCurrentIndex(currentIndex + 1);
    }
  };

  const handlePauseResume = useCallback(async () => {
    if (mode === 'playing') {
      if (soundRef.current) {
        await soundRef.current.pauseAsync();
      }
      setMode('paused');
    } else if (mode === 'paused') {
      if (soundRef.current) {
        await soundRef.current.playAsync();
      }
      setMode('playing');
    }
  }, [mode]);

  const handleExit = useCallback(async () => {
    cleanup();
    reset();
    // 恢复亮度
    try {
      await Brightness.setBrightnessAsync(0.5);
    } catch {}
    // 返回首页（通过 expo-router）
    const { router } = require('expo-router');
    router.replace('/(tabs)');
  }, []);

  const cleanup = async () => {
    if (soundRef.current) {
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const currentText = segments[currentIndex]?.text || '';

  return (
    <RNAnimated.View style={[styles.container, { opacity: fadeAnim }]}>
      {/* 退出按钮 */}
      <TouchableOpacity style={styles.exitBtn} onPress={handleExit}>
        <Text style={styles.exitIcon}>✕</Text>
      </TouchableOpacity>

      {/* 月亮 */}
      <RNAnimated.View style={[styles.moon, { opacity: moonGlow }]}>
        <Text style={styles.moonIcon}>🌙</Text>
      </RNAnimated.View>

      {/* 状态文字 */}
      <View style={styles.centerContent}>
        {mode === 'loading' && (
          <Text style={styles.statusText}>静静在准备晚安碎碎念...</Text>
        )}
        {mode === 'playing' && (
          <>
            <Text style={styles.statusText}>{currentText}</Text>
            <Text style={styles.progressText}>
              {formatTime(elapsed)} / {formatTime(timerMinutes * 60)}
            </Text>
          </>
        )}
        {mode === 'paused' && (
          <>
            <Text style={styles.statusText}>已暂停</Text>
            <Text style={styles.progressText}>
              {formatTime(elapsed)} / {formatTime(timerMinutes * 60)}
            </Text>
          </>
        )}
        {mode === 'finished' && (
          <Text style={styles.statusText}>晚安...做个好梦...</Text>
        )}
      </View>

      {/* 控制栏 */}
      {(mode === 'playing' || mode === 'paused') && (
        <View style={styles.controlBar}>
          {/* 定时器 */}
          <TouchableOpacity
            style={styles.timerBtn}
            onPress={() => setShowTimerPicker(!showTimerPicker)}
          >
            <Text style={styles.timerText}>{timerMinutes}分钟</Text>
          </TouchableOpacity>

          {/* 暂停/播放 */}
          <TouchableOpacity style={styles.pauseBtn} onPress={handlePauseResume}>
            <Text style={styles.pauseIcon}>
              {mode === 'playing' ? '⏸' : '▶'}
            </Text>
          </TouchableOpacity>

          {/* 定时器选择 */}
          {showTimerPicker && (
            <View style={styles.timerPicker}>
              {TIMER_OPTIONS.map((min) => (
                <TouchableOpacity
                  key={min}
                  style={[
                    styles.timerOption,
                    timerMinutes === min && styles.timerOptionActive,
                  ]}
                  onPress={() => {
                    setTimerMinutes(min);
                    setShowTimerPicker(false);
                  }}
                >
                  <Text style={styles.timerOptionText}>{min}分钟</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}
    </RNAnimated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  exitBtn: {
    position: 'absolute',
    top: 50,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  exitIcon: {
    fontSize: 18,
    color: 'rgba(255, 255, 255, 0.5)',
  },
  moon: {
    marginBottom: 40,
  },
  moonIcon: {
    fontSize: 60,
  },
  centerContent: {
    alignItems: 'center',
    paddingHorizontal: 40,
    minHeight: 100,
  },
  statusText: {
    fontSize: 16,
    color: 'rgba(255, 255, 255, 0.6)',
    textAlign: 'center',
    lineHeight: 26,
    fontWeight: '300',
  },
  progressText: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.3)',
    marginTop: 16,
  },
  controlBar: {
    position: 'absolute',
    bottom: 80,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
  },
  timerBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  timerText: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.5)',
  },
  pauseBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  pauseIcon: {
    fontSize: 22,
    color: 'rgba(255, 255, 255, 0.7)',
  },
  timerPicker: {
    position: 'absolute',
    bottom: 70,
    backgroundColor: 'rgba(30, 30, 50, 0.95)',
    borderRadius: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  timerOption: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  timerOptionActive: {
    backgroundColor: 'rgba(230, 126, 34, 0.2)',
  },
  timerOptionText: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.7)',
    textAlign: 'center',
  },
});
