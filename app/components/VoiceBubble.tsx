import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated as RNAnimated } from 'react-native';
import { Audio } from 'expo-av';

interface VoiceBubbleProps {
  audioBase64: string;
  duration: number; // 秒
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
}

export function VoiceBubble({ audioBase64, duration, onPlaybackStart, onPlaybackEnd }: VoiceBubbleProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);
  const progressAnim = useRef(new RNAnimated.Value(0)).current;
  const breathAnim = useRef(new RNAnimated.Value(0.4)).current;

  // 呼吸光效
  useEffect(() => {
    if (isPlaying) {
      const loop = RNAnimated.loop(
        RNAnimated.sequence([
          RNAnimated.timing(breathAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
          RNAnimated.timing(breathAnim, { toValue: 0.4, duration: 800, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      breathAnim.setValue(0.4);
    }
  }, [isPlaying]);

  // 卸载音频
  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync();
    };
  }, []);

  const handlePlay = useCallback(async () => {
    try {
      if (isPlaying && soundRef.current) {
        await soundRef.current.pauseAsync();
        setIsPlaying(false);
        return;
      }

      if (soundRef.current) {
        await soundRef.current.playAsync();
        setIsPlaying(true);
        return;
      }

      // 首次播放：加载音频
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      const uri = `data:audio/wav;base64,${audioBase64}`;
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true },
        (status) => {
          if (status.isLoaded) {
            setPosition(status.positionMillis / 1000);
            progressAnim.setValue(status.positionMillis / (duration * 1000));

            if (status.didJustFinish) {
              setIsPlaying(false);
              setPosition(0);
              progressAnim.setValue(0);
              onPlaybackEnd?.();
            }
          }
        },
      );

      soundRef.current = sound;
      setIsPlaying(true);
      onPlaybackStart?.();
    } catch (e) {
      console.error('[VoiceBubble] Playback error:', e);
      setIsPlaying(false);
    }
  }, [isPlaying, audioBase64, duration]);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  return (
    <TouchableOpacity onPress={handlePlay} style={styles.container} activeOpacity={0.7}>
      {/* 播放按钮 */}
      <Animated.View style={[styles.playBtn, { opacity: breathAnim }]}>
        <Text style={styles.playIcon}>{isPlaying ? '⏸' : '▶'}</Text>
      </Animated.View>

      {/* 波形条 */}
      <View style={styles.waveform}>
        {Array.from({ length: 20 }).map((_, i) => {
          const height = 4 + Math.sin(i * 0.8) * 10 + Math.random() * 6;
          return (
            <View
              key={i}
              style={[
                styles.waveBar,
                { height },
                i / 20 < position / duration && styles.waveBarActive,
              ]}
            />
          );
        })}
      </View>

      {/* 时长 */}
      <Text style={styles.duration}>{formatTime(duration)}</Text>
    </TouchableOpacity>
  );
}

// 兼容 Animated.View
const Animated = { View: RNAnimated.View };

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    minWidth: 160,
  },
  playBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(230, 126, 34, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  playIcon: {
    fontSize: 12,
    color: '#e67e22',
  },
  waveform: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flex: 1,
  },
  waveBar: {
    width: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(139, 164, 184, 0.3)',
  },
  waveBarActive: {
    backgroundColor: '#e67e22',
  },
  duration: {
    fontSize: 11,
    color: '#888',
    marginLeft: 8,
    minWidth: 30,
  },
});
