import React, { useEffect, useRef } from 'react';
import { TouchableOpacity, StyleSheet, Animated as RNAnimated, Text } from 'react-native';

interface MoonButtonProps {
  onPress?: () => void;
}

export function MoonButton({ onPress }: MoonButtonProps) {
  const glowAnim = useRef(new RNAnimated.Value(0.3)).current;

  useEffect(() => {
    const glow = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(glowAnim, {
          toValue: 0.8,
          duration: 3000,
          useNativeDriver: true,
        }),
        RNAnimated.timing(glowAnim, {
          toValue: 0.3,
          duration: 3000,
          useNativeDriver: true,
        }),
      ])
    );
    glow.start();
    return () => glow.stop();
  }, []);

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={onPress}
      activeOpacity={0.6}
    >
      <RNAnimated.View style={[styles.iconWrapper, { opacity: glowAnim }]}>
        <Text style={styles.moonIcon}>🌙</Text>
      </RNAnimated.View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 50,
    right: 20,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapper: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(26, 26, 46, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  moonIcon: {
    fontSize: 18,
  },
});
