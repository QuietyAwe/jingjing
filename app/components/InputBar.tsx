import React, { useEffect, useRef } from 'react';
import { View, TextInput, StyleSheet, TouchableOpacity, Animated as RNAnimated } from 'react-native';

interface InputBarProps {
  onPress?: () => void;
}

export function InputBar({ onPress }: InputBarProps) {
  const breatheAnim = useRef(new RNAnimated.Value(0.4)).current;

  useEffect(() => {
    const breathe = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(breatheAnim, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
        }),
        RNAnimated.timing(breatheAnim, {
          toValue: 0.4,
          duration: 2000,
          useNativeDriver: true,
        }),
      ])
    );
    breathe.start();
    return () => breathe.stop();
  }, []);

  return (
    <View style={styles.container}>
      {/* 静静头像呼吸灯 */}
      <RNAnimated.View style={[styles.avatar, { opacity: breatheAnim }]}>
        <View style={styles.avatarInner}>
          <View style={styles.avatarDot} />
        </View>
      </RNAnimated.View>

      {/* 输入框 */}
      <TouchableOpacity
        style={styles.inputWrapper}
        onPress={onPress}
        activeOpacity={0.7}
      >
        <TextInput
          style={styles.input}
          placeholder="和静静说点什么..."
          placeholderTextColor="rgba(255, 255, 255, 0.3)"
          editable={false}
          pointerEvents="none"
        />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 34,
    paddingTop: 12,
    backgroundColor: 'rgba(15, 15, 26, 0.6)',
  },
  avatar: {
    marginRight: 10,
  },
  avatarInner: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(42, 42, 78, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(74, 74, 122, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#e67e22',
  },
  inputWrapper: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(26, 26, 46, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(58, 58, 94, 0.5)',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  input: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.5)',
  },
});
