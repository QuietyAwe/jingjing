import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated as RNAnimated } from 'react-native';
import { Message } from '../stores/chat';
import { VoiceBubble } from './VoiceBubble';

interface MessageBubbleProps {
  message: Message;
  onVoiceStart?: () => void;
  onVoiceEnd?: () => void;
}

export function MessageBubble({ message, onVoiceStart, onVoiceEnd }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const fadeAnim = useRef(new RNAnimated.Value(0)).current;
  const slideAnim = useRef(new RNAnimated.Value(20)).current;

  useEffect(() => {
    RNAnimated.parallel([
      RNAnimated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
      RNAnimated.timing(slideAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return (
    <RNAnimated.View
      style={[
        styles.row,
        isUser ? styles.rowUser : styles.rowAssistant,
        { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
      ]}
    >
      {!isUser && (
        <View style={styles.avatar}>
          <View style={styles.avatarDot} />
        </View>
      )}
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
        ]}
      >
        {/* 语音气泡（有音频时显示） */}
        {!isUser && message.audioBase64 ? (
          <VoiceBubble
            audioBase64={message.audioBase64}
            duration={message.audioDuration || 1}
            onPlaybackStart={onVoiceStart}
            onPlaybackEnd={onVoiceEnd}
          />
        ) : null}

        {/* 文字内容 */}
        {message.content ? (
          <Text style={[styles.text, isUser ? styles.textUser : styles.textAssistant]}>
            {message.content}
          </Text>
        ) : null}
      </View>
    </RNAnimated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginVertical: 4,
    paddingHorizontal: 12,
    alignItems: 'flex-end',
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowAssistant: {
    justifyContent: 'flex-start',
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(42, 42, 78, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(74, 74, 122, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  avatarDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#e67e22',
  },
  bubble: {
    maxWidth: '75%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleUser: {
    backgroundColor: 'rgba(240, 240, 245, 0.9)',
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: 'rgba(42, 50, 70, 0.9)',
    borderBottomLeftRadius: 4,
  },
  text: {
    fontSize: 15,
    lineHeight: 22,
  },
  textUser: {
    color: '#1a1a2e',
  },
  textAssistant: {
    color: '#d0d0e0',
  },
});
