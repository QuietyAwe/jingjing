import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated as RNAnimated } from 'react-native';
import { useRouter } from 'expo-router';
import { useOnboardingStore } from '../../stores/onboarding';
import { updateUser } from '../../services/user';

const TIMEOUT_MS = 30000; // 30 秒超时

export default function AnchorScreen() {
  const router = useRouter();
  const { userId, callName, setCallName, setStep } = useOnboardingStore();
  const [selected, setSelected] = useState<string | null>(null);
  const [showQuestion, setShowQuestion] = useState(false);
  const fadeAnim = useRef(new RNAnimated.Value(0)).current;
  const buttonFade = useRef(new RNAnimated.Value(0)).current;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 淡入显示问题
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowQuestion(true);
      RNAnimated.timing(fadeAnim, {
        toValue: 1,
        duration: 1500,
        useNativeDriver: true,
      }).start(() => {
        // 问题显示后，淡入按钮
        RNAnimated.timing(buttonFade, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }).start();
      });
    }, 500);

    // 超时默认选择
    timeoutRef.current = setTimeout(() => {
      if (!selected) {
        handleSelect('gege');
      }
    }, TIMEOUT_MS);

    return () => {
      clearTimeout(timer);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleSelect = async (name: string) => {
    if (selected) return;
    setSelected(name);
    setCallName(name);

    // 更新后端
    try {
      if (userId) {
        await updateUser(userId, { call_name: name });
      }
    } catch (error) {
      console.error('Failed to update call_name:', error);
    }

    // 跳转到首页
    setTimeout(() => {
      setStep('complete');
      router.replace('/(tabs)');
    }, 800);
  };

  return (
    <View style={styles.container}>
      {/* 静静的头像占位 */}
      <View style={styles.avatarContainer}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>静</Text>
        </View>
      </View>

      {/* 问题 */}
      <RNAnimated.View style={[styles.questionContainer, { opacity: fadeAnim }]}>
        <Text style={styles.questionText}>
          {showQuestion && '那...静静叫你哥哥好...还是姐姐好...'}
        </Text>
      </RNAnimated.View>

      {/* 选项 */}
      <RNAnimated.View style={[styles.optionsContainer, { opacity: buttonFade }]}>
        <TouchableOpacity
          style={[
            styles.optionButton,
            selected === 'gege' && styles.optionSelected,
          ]}
          onPress={() => handleSelect('gege')}
          disabled={!!selected}
          activeOpacity={0.7}
        >
          <Text style={styles.optionText}>哥哥</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.optionButton,
            selected === 'jiejie' && styles.optionSelected,
          ]}
          onPress={() => handleSelect('jiejie')}
          disabled={!!selected}
          activeOpacity={0.7}
        >
          <Text style={styles.optionText}>姐姐</Text>
        </TouchableOpacity>
      </RNAnimated.View>

      {/* 选中后的反馈 */}
      {selected && (
        <Text style={styles.feedbackText}>
          嗯...{selected === 'gege' ? '哥哥' : '姐姐'}...静静记住了...
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  avatarContainer: {
    marginBottom: 40,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#2a2a4e',
    borderWidth: 2,
    borderColor: '#4a4a7a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 32,
    color: '#8a8abb',
    fontWeight: '300',
  },
  questionContainer: {
    marginBottom: 50,
    minHeight: 60,
    justifyContent: 'center',
  },
  questionText: {
    fontSize: 18,
    color: '#c0c0d0',
    textAlign: 'center',
    lineHeight: 30,
    letterSpacing: 1,
  },
  optionsContainer: {
    flexDirection: 'row',
    gap: 30,
  },
  optionButton: {
    paddingVertical: 16,
    paddingHorizontal: 40,
    borderRadius: 30,
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#3a3a5e',
  },
  optionSelected: {
    backgroundColor: '#2a2a4e',
    borderColor: '#e67e22',
  },
  optionText: {
    fontSize: 18,
    color: '#e0e0e0',
    letterSpacing: 2,
  },
  feedbackText: {
    marginTop: 40,
    fontSize: 14,
    color: '#8a8aaa',
    letterSpacing: 1,
  },
});
