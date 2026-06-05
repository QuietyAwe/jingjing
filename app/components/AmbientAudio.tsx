import React, { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Audio } from 'expo-av';
import { getSceneConfig } from '../constants/scenes';
import { useHomeStore } from '../stores/home';

export interface AmbientAudioRef {
  duck: (enable: boolean) => void; // true=压低, false=恢复
}

export const AmbientAudio = forwardRef<AmbientAudioRef>(function AmbientAudio(_, ref) {
  const { timeOfDay, weatherText } = useHomeStore();
  const soundRef = useRef<Audio.Sound | null>(null);
  const baseVolume = useRef(0.15);
  const currentVolume = useRef(0.15);

  // 初始化音频模式
  useEffect(() => {
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: true,
    });
  }, []);

  // 底噪压制/恢复
  const duck = useCallback((enable: boolean) => {
    if (!soundRef.current) return;
    const target = enable ? baseVolume.current / 4 : baseVolume.current;
    currentVolume.current = target;
    soundRef.current.setVolumeAsync(target);
  }, []);

  // 暴露方法给父组件
  useImperativeHandle(ref, () => ({ duck }), [duck]);

  // 场景切换时更新音频
  useEffect(() => {
    const scene = getSceneConfig(timeOfDay, weatherText);
    loadAmbientSound(scene.ambientSound);

    return () => {
      unloadSound();
    };
  }, [timeOfDay, weatherText]);

  const loadAmbientSound = async (soundName: string) => {
    try {
      await unloadSound();

      // Phase 7：使用实际音频文件（assets/sounds/ 目录下）
      // 若文件不存在则静默降级
      try {
        const source = _getAmbientSource(soundName);
        const { sound } = await Audio.Sound.createAsync(source, {
          isLooping: true,
          volume: baseVolume.current,
        });
        soundRef.current = sound;
        await sound.playAsync();
      } catch {
        // 音频文件不存在，静默降级（不播放）
        console.log(`[AmbientAudio] Sound file not found: ${soundName}, silent fallback`);
      }
    } catch (error) {
      console.error('[AmbientAudio] Failed to load sound:', error);
    }
  };

  const unloadSound = async () => {
    if (soundRef.current) {
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }
  };

  return null;
});

// 底噪文件映射（assets/sounds/ 目录）
// 音频文件需手动放入 app/assets/sounds/ 目录
// 未放入时自动静默降级（不播放底噪）
function _getAmbientSource(name: string) {
  // 使用 expo-asset 的 URI 方式加载，避免 require 缺失文件导致打包失败
  // 实际音频文件放入后，此处改为 require 方式即可
  const SOUND_MAP: Record<string, string> = {
    rain: 'rain.mp3',
    thunder: 'thunder.mp3',
    wind: 'wind.mp3',
    night: 'night.mp3',
    bird: 'bird.mp3',
    cricket: 'cricket.mp3',
    snow: 'snow.mp3',
    fog: 'fog.mp3',
  };
  // 返回一个占位 URI（音频文件不存在时播放会静默失败）
  return { uri: `asset:/sounds/${SOUND_MAP[name] || SOUND_MAP['night']}` };
}
