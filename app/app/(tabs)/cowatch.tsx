import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { FloatingCapsule } from '../../components/FloatingCapsule';
import { FocusMode } from '../../components/FocusMode';
import { analyzeScreen } from '../../services/vision';
import { generateTTS } from '../../services/voice';
import { Audio } from 'expo-av';

export default function CoWatchScreen() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [reaction, setReaction] = useState('');
  const [isIdle, setIsIdle] = useState(false);
  const [showCapsule, setShowCapsule] = useState(false);
  const [showFocus, setShowFocus] = useState(false);

  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  // 开始/停止同频共振
  const toggleCapture = useCallback(async () => {
    if (isCapturing) {
      stopCapture();
    } else {
      startCapture();
    }
  }, [isCapturing]);

  const startCapture = () => {
    setIsCapturing(true);
    setShowCapsule(true);
    setIsIdle(false);
    setReaction('静静开始看着你了...');

    // 每 8 秒模拟一次屏幕分析（生产环境接入真实截屏）
    captureIntervalRef.current = setInterval(() => {
      simulateAnalyze();
    }, 8000);

    resetIdleTimer();
  };

  const stopCapture = () => {
    setIsCapturing(false);
    setShowCapsule(false);
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };

  // Mock 分析（生产环境替换为真实截屏 + Vision-LLM）
  const simulateAnalyze = async () => {
    try {
      const result = await analyzeScreen('', '用户正在看屏幕');
      setReaction(result.reaction);
      playReaction(result.reaction);
      resetIdleTimer();
    } catch (e) {
      console.error('[CoWatch] Analyze error:', e);
    }
  };

  const playReaction = async (text: string) => {
    try {
      const result = await generateTTS(text);
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
      }
      const { sound } = await Audio.Sound.createAsync(
        { uri: `data:audio/wav;base64,${result.audio}` },
        { shouldPlay: true },
      );
      soundRef.current = sound;
    } catch (e) {
      // TTS 失败静默处理
    }
  };

  const resetIdleTimer = () => {
    setIsIdle(false);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      setIsIdle(true);
    }, 5 * 60 * 1000);
  };

  useEffect(() => {
    return () => {
      stopCapture();
      soundRef.current?.unloadAsync();
    };
  }, []);

  return (
    <View style={styles.container}>
      {/* 标题 */}
      <View style={styles.header}>
        <Text style={styles.title}>同频共振</Text>
        <Text style={styles.subtitle}>让静静看着你...</Text>
      </View>

      {/* 状态卡片 */}
      <View style={styles.card}>
        <Text style={styles.cardIcon}>{isCapturing ? '📡' : '📴'}</Text>
        <Text style={styles.cardTitle}>
          {isCapturing ? '正在同步中...' : '同频共振未开启'}
        </Text>
        <Text style={styles.cardDesc}>
          {isCapturing
            ? '静静正在看着你...'
            : '开启后静静会看着你在做什么，并给出语音反馈'}
        </Text>
      </View>

      {/* 开启/关闭按钮 */}
      <TouchableOpacity style={styles.mainBtn} onPress={toggleCapture}>
        <Text style={styles.mainBtnText}>
          {isCapturing ? '关闭同频共振' : '开启同频共振'}
        </Text>
      </TouchableOpacity>

      {/* Focus Mode 入口 */}
      <TouchableOpacity
        style={styles.focusBtn}
        onPress={() => setShowFocus(true)}
      >
        <Text style={styles.focusBtnIcon}>📖</Text>
        <View>
          <Text style={styles.focusBtnTitle}>专注模式</Text>
          <Text style={styles.focusBtnDesc}>和静静一起专注...</Text>
        </View>
      </TouchableOpacity>

      {/* 说明 */}
      <View style={styles.noteCard}>
        <Text style={styles.noteText}>
          💡 同频共振每 8 秒分析一次屏幕内容，静静会根据你在做的事情给出语音反馈。
          5 分钟无操作后进入休眠态。
        </Text>
      </View>

      {/* 悬浮胶囊 */}
      <FloatingCapsule
        visible={showCapsule}
        reaction={reaction}
        isIdle={isIdle}
        onClose={stopCapture}
        onPress={() => {
          if (reaction) playReaction(reaction);
        }}
      />

      {/* Focus Mode */}
      <FocusMode
        visible={showFocus}
        onClose={() => setShowFocus(false)}
        onComplete={() => {
          Alert.alert('✨', '专注完成！静静好开心~');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 20,
    paddingTop: 60,
  },
  header: {
    marginBottom: 32,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: '#E8E8E8',
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.4)',
    marginTop: 4,
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    marginBottom: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  cardIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#E8E8E8',
    marginBottom: 6,
  },
  cardDesc: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.4)',
    textAlign: 'center',
    lineHeight: 20,
  },
  mainBtn: {
    backgroundColor: '#e67e22',
    paddingVertical: 14,
    borderRadius: 24,
    alignItems: 'center',
    marginBottom: 20,
  },
  mainBtnText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#fff',
  },
  focusBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 16,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    marginBottom: 16,
  },
  focusBtnIcon: {
    fontSize: 28,
  },
  focusBtnTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: '#E8E8E8',
  },
  focusBtnDesc: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    marginTop: 2,
  },
  noteCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 12,
    padding: 14,
  },
  noteText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.3)',
    lineHeight: 18,
  },
});
