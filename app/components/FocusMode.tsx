import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated as RNAnimated,
} from 'react-native';

interface FocusModeProps {
  visible: boolean;
  onClose: () => void;
  onComplete?: () => void;
}

const PRESET_MINUTES = [25, 45, 60];

export function FocusMode({ visible, onClose, onComplete }: FocusModeProps) {
  const [durationMin, setDurationMin] = useState(25);
  const [remaining, setRemaining] = useState(0); // 秒
  const [isRunning, setIsRunning] = useState(false);
  const [phase, setPhase] = useState<'setup' | 'running' | 'done'>('setup');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fadeAnim = useRef(new RNAnimated.Value(0)).current;

  // 淡入动画
  useEffect(() => {
    if (visible) {
      setPhase('setup');
      setIsRunning(false);
      setRemaining(0);
      RNAnimated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } else {
      fadeAnim.setValue(0);
    }
  }, [visible]);

  // 倒计时
  useEffect(() => {
    if (isRunning && remaining > 0) {
      timerRef.current = setInterval(() => {
        setRemaining((prev) => {
          if (prev <= 1) {
            setIsRunning(false);
            setPhase('done');
            onComplete?.();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
  }, [isRunning]);

  const handleStart = useCallback(() => {
    setRemaining(durationMin * 60);
    setIsRunning(true);
    setPhase('running');
  }, [durationMin]);

  const handleStop = useCallback(() => {
    setIsRunning(false);
    if (timerRef.current) clearInterval(timerRef.current);
    onClose();
  }, [onClose]);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  if (!visible) return null;

  return (
    <RNAnimated.View style={[styles.container, { opacity: fadeAnim }]}>
      {/* 设置阶段 */}
      {phase === 'setup' && (
        <View style={styles.setupContainer}>
          <Text style={styles.title}>专注时间</Text>
          <Text style={styles.subtitle}>静静会在旁边安静地陪你...</Text>

          <View style={styles.presetRow}>
            {PRESET_MINUTES.map((min) => (
              <TouchableOpacity
                key={min}
                style={[styles.presetBtn, durationMin === min && styles.presetBtnActive]}
                onPress={() => setDurationMin(min)}
              >
                <Text style={[styles.presetText, durationMin === min && styles.presetTextActive]}>
                  {min}分钟
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity style={styles.startBtn} onPress={handleStart}>
            <Text style={styles.startBtnText}>开始专注</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelText}>取消</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 运行阶段 */}
      {phase === 'running' && (
        <View style={styles.runningContainer}>
          {/* 静静动画占位（Lottie） */}
          <View style={styles.animPlaceholder}>
            <Text style={styles.animText}>📖</Text>
            <Text style={styles.animLabel}>静静在看书...</Text>
          </View>

          <Text style={styles.timer}>{formatTime(remaining)}</Text>
          <Text style={styles.hint}>专注中...静静陪着你...</Text>

          <TouchableOpacity style={styles.stopBtn} onPress={handleStop}>
            <Text style={styles.stopText}>结束专注</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 完成阶段 */}
      {phase === 'done' && (
        <View style={styles.doneContainer}>
          <Text style={styles.doneIcon}>✨</Text>
          <Text style={styles.doneTitle}>专注完成！</Text>
          <Text style={styles.doneSubtitle}>静静好开心...{durationMin}分钟很快就过去了...</Text>

          <TouchableOpacity style={styles.closeDoneBtn} onPress={onClose}>
            <Text style={styles.closeDoneText}>回到听雨空间</Text>
          </TouchableOpacity>
        </View>
      )}
    </RNAnimated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(15, 15, 26, 0.96)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  // 设置
  setupContainer: {
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: '300',
    color: '#E8E8E8',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.4)',
    marginBottom: 32,
  },
  presetRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 32,
  },
  presetBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  presetBtnActive: {
    backgroundColor: 'rgba(230, 126, 34, 0.2)',
    borderColor: 'rgba(230, 126, 34, 0.4)',
  },
  presetText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.5)',
  },
  presetTextActive: {
    color: '#e67e22',
  },
  startBtn: {
    paddingHorizontal: 40,
    paddingVertical: 14,
    borderRadius: 24,
    backgroundColor: '#e67e22',
    marginBottom: 16,
  },
  startBtnText: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '500',
  },
  cancelBtn: {
    padding: 8,
  },
  cancelText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.3)',
  },
  // 运行
  runningContainer: {
    alignItems: 'center',
  },
  animPlaceholder: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(230, 126, 34, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  animText: {
    fontSize: 48,
  },
  animLabel: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    marginTop: 4,
  },
  timer: {
    fontSize: 56,
    fontWeight: '200',
    color: '#E8E8E8',
    marginBottom: 8,
  },
  hint: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.3)',
    marginBottom: 40,
  },
  stopBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  stopText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.5)',
  },
  // 完成
  doneContainer: {
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  doneIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  doneTitle: {
    fontSize: 22,
    fontWeight: '400',
    color: '#E8E8E8',
    marginBottom: 8,
  },
  doneSubtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
    marginBottom: 32,
  },
  closeDoneBtn: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 20,
    backgroundColor: 'rgba(230, 126, 34, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(230, 126, 34, 0.3)',
  },
  closeDoneText: {
    fontSize: 15,
    color: '#e67e22',
  },
});
