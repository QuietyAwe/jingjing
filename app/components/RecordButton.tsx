import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated as RNAnimated,
  Alert,
} from 'react-native';
import { Audio } from 'expo-av';

interface RecordButtonProps {
  onRecorded: (audioBase64: string, durationMs: number) => void;
  disabled?: boolean;
}

export function RecordButton({ onRecorded, disabled }: RecordButtonProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseAnim = useRef(new RNAnimated.Value(1)).current;

  // 录音脉冲动效
  const startPulse = useCallback(() => {
    const loop = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(pulseAnim, { toValue: 1.3, duration: 500, useNativeDriver: true }),
        RNAnimated.timing(pulseAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return loop;
  }, []);

  const handlePressIn = useCallback(async () => {
    if (disabled) return;

    try {
      // 请求权限
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('提示', '需要麦克风权限才能录音');
        return;
      }

      // 配置录音
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      await recording.startAsync();
      recordingRef.current = recording;
      setIsRecording(true);
      setRecordingDuration(0);

      // 计时器
      const startTime = Date.now();
      timerRef.current = setInterval(() => {
        setRecordingDuration(Date.now() - startTime);
      }, 100);

      startPulse();
    } catch (e) {
      console.error('[RecordButton] Start error:', e);
    }
  }, [disabled, startPulse]);

  const handlePressOut = useCallback(async () => {
    if (!recordingRef.current) return;

    try {
      // 停止录音
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

      // 清理
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setIsRecording(false);
      pulseAnim.setValue(1);

      // 恢复音频模式
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
      });

      if (!uri) return;

      // 读取音频为 base64
      const response = await fetch(uri);
      const blob = await response.blob();
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(',')[1];
        if (base64) {
          onRecorded(base64, recordingDuration);
        }
      };
      reader.readAsDataURL(blob);
    } catch (e) {
      console.error('[RecordButton] Stop error:', e);
      setIsRecording(false);
    }
  }, [recordingDuration, onRecorded]);

  const handleCancel = useCallback(async () => {
    if (recordingRef.current) {
      try {
        await recordingRef.current.stopAndUnloadAsync();
      } catch {}
      recordingRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
    pulseAnim.setValue(1);
  }, []);

  const formatDuration = (ms: number) => {
    const sec = Math.floor(ms / 1000);
    return `${sec}s`;
  };

  if (isRecording) {
    return (
      <View style={styles.recordingContainer}>
        <TouchableOpacity onPress={handleCancel} style={styles.cancelBtn}>
          <Text style={styles.cancelText}>取消</Text>
        </TouchableOpacity>

        <Animated.View style={[styles.recordDot, { transform: [{ scale: pulseAnim }] }]}>
          <View style={styles.recordDotInner} />
        </Animated.View>

        <Text style={styles.durationText}>{formatDuration(recordingDuration)}</Text>

        <TouchableOpacity onPress={handlePressOut} style={styles.sendRecordBtn}>
          <Text style={styles.sendRecordText}>发送</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <TouchableOpacity
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[styles.micButton, disabled && styles.micButtonDisabled]}
      disabled={disabled}
    >
      <Text style={styles.micIcon}>🎤</Text>
    </TouchableOpacity>
  );
}

const Animated = { View: RNAnimated.View };

const styles = StyleSheet.create({
  micButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(139, 164, 184, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonDisabled: {
    opacity: 0.4,
  },
  micIcon: {
    fontSize: 18,
  },
  recordingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  cancelBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  cancelText: {
    color: '#888',
    fontSize: 14,
  },
  recordDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#e74c3c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordDotInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#fff',
  },
  durationText: {
    color: '#e74c3c',
    fontSize: 14,
    minWidth: 30,
  },
  sendRecordBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(230, 126, 34, 0.3)',
  },
  sendRecordText: {
    color: '#e67e22',
    fontSize: 14,
  },
});
