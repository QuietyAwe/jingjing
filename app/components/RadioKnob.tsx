import React from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  runOnJS,
} from 'react-native-reanimated';

const KNOB_SIZE = 180;
const MAX_ROTATION = 360;

interface RadioKnobProps {
  onRotationChange: (progress: number) => void; // 0-1
  targetProgress: number; // 目标位置 0-1
  disabled?: boolean;
}

export function RadioKnob({ onRotationChange, targetProgress, disabled }: RadioKnobProps) {
  const rotation = useSharedValue(0);
  const savedRotation = useSharedValue(0);

  const panGesture = Gesture.Pan()
    .enabled(!disabled)
    .onUpdate((event: { translationX: number; translationY: number }) => {
      const delta = (event.translationX + event.translationY) / 2;
      const newRotation = savedRotation.value + delta;
      rotation.value = Math.max(0, Math.min(MAX_ROTATION, newRotation));
      const progress = rotation.value / MAX_ROTATION;
      runOnJS(onRotationChange)(progress);
    })
    .onEnd(() => {
      savedRotation.value = rotation.value;
    });

  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const targetAngle = targetProgress * MAX_ROTATION;

  return (
    <View style={styles.container}>
      <View style={styles.dial}>
        <View
          style={[
            styles.targetIndicator,
            { transform: [{ rotate: `${targetAngle}deg` }] },
          ]}
        >
          <View style={styles.targetDot} />
        </View>
        <GestureDetector gesture={panGesture}>
          <Animated.View style={[styles.knob, knobStyle]}>
            <View style={styles.knobCenter} />
            <View style={styles.knobLine} />
          </Animated.View>
        </GestureDetector>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  dial: {
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: KNOB_SIZE / 2,
    backgroundColor: '#2a2a3e',
    borderWidth: 3,
    borderColor: '#4a4a6a',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 8,
  },
  targetIndicator: {
    position: 'absolute',
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    alignItems: 'center',
  },
  targetDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#e67e22',
    marginTop: 6,
  },
  knob: {
    width: KNOB_SIZE - 30,
    height: KNOB_SIZE - 30,
    borderRadius: (KNOB_SIZE - 30) / 2,
    backgroundColor: '#3a3a5e',
    borderWidth: 2,
    borderColor: '#5a5a8a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  knobCenter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#e67e22',
  },
  knobLine: {
    position: 'absolute',
    width: 2,
    height: (KNOB_SIZE - 30) / 2 - 10,
    backgroundColor: '#e67e22',
    top: 10,
  },
});
