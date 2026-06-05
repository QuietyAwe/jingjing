import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  Animated as RNAnimated,
} from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const CAPSULE_W = 180;
const CAPSULE_H = 50;
const EDGE_THRESHOLD = 30;

interface FloatingCapsuleProps {
  visible: boolean;
  reaction: string;
  isIdle: boolean; // 5 分钟无操作 → 休眠态
  onClose: () => void;
  onPress?: () => void;
}

export function FloatingCapsule({ visible, reaction, isIdle, onClose, onPress }: FloatingCapsuleProps) {
  const translateX = useRef(new RNAnimated.Value(SCREEN_W - CAPSULE_W - 16)).current;
  const translateY = useRef(new RNAnimated.Value(200)).current;
  const opacity = useRef(new RNAnimated.Value(visible ? 1 : 0)).current;
  const breathAnim = useRef(new RNAnimated.Value(0.6)).current;

  // 可见性动画
  useEffect(() => {
    RNAnimated.timing(opacity, {
      toValue: visible ? (isIdle ? 0.3 : 1) : 0,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, [visible, isIdle]);

  // 呼吸光效
  useEffect(() => {
    if (visible && !isIdle) {
      const loop = RNAnimated.loop(
        RNAnimated.sequence([
          RNAnimated.timing(breathAnim, { toValue: 1, duration: 1500, useNativeDriver: true }),
          RNAnimated.timing(breathAnim, { toValue: 0.6, duration: 1500, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    }
  }, [visible, isIdle]);

  // 拖拽手势
  const onGestureEvent = RNAnimated.event(
    [
      {
        nativeEvent: {
          translationX: translateX,
          translationY: translateY,
        },
      },
    ],
    { useNativeDriver: true },
  );

  const onHandlerStateChange = useCallback(
    (event: any) => {
      if (event.nativeEvent.oldState === State.ACTIVE) {
        // 吸边处理
        const finalX = (translateX as any)._value + event.nativeEvent.translationX;
        const finalY = (translateY as any)._value + event.nativeEvent.translationY;

        // 限制 Y 范围
        const clampedY = Math.max(60, Math.min(SCREEN_H - CAPSULE_H - 100, finalY));

        // 吸边：左或右
        const snapX = finalX < SCREEN_W / 2 ? -CAPSULE_W / 2 : SCREEN_W - CAPSULE_W / 2;

        translateX.extractOffset();
        translateY.extractOffset();

        RNAnimated.parallel([
          RNAnimated.spring(translateX, {
            toValue: snapX,
            useNativeDriver: true,
            bounciness: 0,
          }),
          RNAnimated.spring(translateY, {
            toValue: clampedY,
            useNativeDriver: true,
            bounciness: 8,
          }),
        ]).start();
      }
    },
    [],
  );

  if (!visible) return null;

  return (
    <PanGestureHandler
      onGestureEvent={onGestureEvent}
      onHandlerStateChange={onHandlerStateChange}
    >
      <RNAnimated.View
        style={[
          styles.container,
          {
            opacity,
            transform: [{ translateX }, { translateY }],
          },
        ]}
      >
        <TouchableOpacity onPress={onPress} style={styles.inner} activeOpacity={0.8}>
          {/* 头像 */}
          <RNAnimated.View style={[styles.avatar, { opacity: breathAnim }]}>
            <Text style={styles.avatarText}>静</Text>
          </RNAnimated.View>

          {/* Reaction 文字 */}
          <Text style={styles.reactionText} numberOfLines={2}>
            {reaction || '静静在看着你...'}
          </Text>

          {/* 关闭 */}
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </RNAnimated.View>
    </PanGestureHandler>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    width: CAPSULE_W,
    zIndex: 999,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(26, 26, 46, 0.9)',
    borderRadius: 25,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    gap: 6,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(230, 126, 34, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 14,
    color: '#e67e22',
    fontWeight: '600',
  },
  reactionText: {
    flex: 1,
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.7)',
    lineHeight: 16,
  },
  closeBtn: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    fontSize: 10,
    color: 'rgba(255, 255, 255, 0.5)',
  },
});
