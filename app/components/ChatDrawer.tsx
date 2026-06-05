import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  Animated as RNAnimated,
  TouchableOpacity,
  Text,
  KeyboardAvoidingView,
  Platform,
  FlatList,
  Dimensions,
} from 'react-native';
import { useChatStore, Message, genId } from '../stores/chat';
import { useOnboardingStore } from '../stores/onboarding';
import { useHomeStore } from '../stores/home';
import { sendChatMessage } from '../services/chat';
import { generateTTS } from '../services/voice';
import { MessageBubble } from './MessageBubble';
import { RecordButton } from './RecordButton';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const HALF_SCREEN = SCREEN_HEIGHT * 0.6;

interface ChatDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onAmbientDuck?: (duck: boolean) => void; // 底噪压制回调
}

export function ChatDrawer({ isOpen, onClose, onAmbientDuck }: ChatDrawerProps) {
  const { userId } = useOnboardingStore();
  const {
    messages,
    isTyping,
    addMessage,
    appendToLastMessage,
    setLastMessageAudio,
    setTyping,
  } = useChatStore();
  const { setDrawerOpen } = useHomeStore();
  const [inputText, setInputText] = useState('');
  const slideAnim = useRef(new RNAnimated.Value(SCREEN_HEIGHT)).current;
  const flatListRef = useRef<FlatList>(null);

  // 打开/关闭动画
  useEffect(() => {
    RNAnimated.spring(slideAnim, {
      toValue: isOpen ? 0 : SCREEN_HEIGHT,
      damping: 20,
      stiffness: 90,
      useNativeDriver: true,
    }).start();
    setDrawerOpen(isOpen);
  }, [isOpen]);

  // 自动滚动到底部
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages.length, isTyping]);

  // 发送文本消息
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !userId) return;

    setInputText('');
    const userMsg: Message = {
      id: genId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    addMessage(userMsg);

    setTyping(true);
    const assistantMsg: Message = {
      id: genId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    addMessage(assistantMsg);

    await sendChatMessage(userId, text, {
      onToken: (token) => appendToLastMessage(token),
      onDone: () => {
        setTyping(false);
        // 自动 TTS 生成（异步，不阻塞）
        generateTTSForLastMessage();
      },
      onError: (err) => {
        console.error('Chat error:', err);
        appendToLastMessage('...静静好像走神了...');
        setTyping(false);
      },
    });
  }, [inputText, userId]);

  // 语音输入
  const handleRecorded = useCallback(
    async (audioBase64: string, durationMs: number) => {
      if (!userId) return;

      // mock ASR（生产环境调用后端 ASR API）
      const text = durationMs < 3000 ? '嗯...' : '静静...静静好想你...';

      const userMsg: Message = {
        id: genId(),
        role: 'user',
        content: `[语音] ${text}`,
        timestamp: Date.now(),
      };
      addMessage(userMsg);

      setTyping(true);
      const assistantMsg: Message = {
        id: genId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      };
      addMessage(assistantMsg);

      await sendChatMessage(userId, text, {
        onToken: (token) => appendToLastMessage(token),
        onDone: () => {
          setTyping(false);
          generateTTSForLastMessage();
        },
        onError: () => {
          appendToLastMessage('...静静好像走神了...');
          setTyping(false);
        },
      });
    },
    [userId],
  );

  // 为最后一条助手消息生成 TTS
  const generateTTSForLastMessage = useCallback(async () => {
    const msgs = useChatStore.getState().messages;
    const lastMsg = msgs[msgs.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant' || !lastMsg.content) return;

    try {
      const result = await generateTTS(lastMsg.content);
      setLastMessageAudio(result.audio, result.duration);
    } catch (e) {
      console.error('[TTS] Generation failed:', e);
    }
  }, []);

  // 语音播放时压制底噪
  const handleVoiceStart = useCallback(() => {
    onAmbientDuck?.(true);
  }, [onAmbientDuck]);

  const handleVoiceEnd = useCallback(() => {
    onAmbientDuck?.(false);
  }, [onAmbientDuck]);

  return (
    <RNAnimated.View
      style={[
        styles.container,
        { transform: [{ translateY: slideAnim }] },
      ]}
    >
      {/* 磨砂背景层 */}
      <View style={styles.backdrop} />

      {/* Grab Handle */}
      <View style={styles.handleContainer}>
        <View style={styles.handle} />
      </View>

      {/* 顶栏 */}
      <View style={styles.topBar}>
        <Text style={styles.topBarTitle}>
          {isTyping ? '静静正在输入...' : '静静'}
        </Text>
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <Text style={styles.closeText}>收起</Text>
        </TouchableOpacity>
      </View>

      {/* 消息列表 */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            onVoiceStart={handleVoiceStart}
            onVoiceEnd={handleVoiceEnd}
          />
        )}
        style={styles.messageList}
        contentContainerStyle={styles.messageListContent}
        showsVerticalScrollIndicator={false}
      />

      {/* 输入区 */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={styles.inputContainer}>
          {/* 录音按钮 */}
          <RecordButton onRecorded={handleRecorded} disabled={isTyping} />

          {/* 文字输入 */}
          <TextInput
            style={styles.input}
            value={inputText}
            onChangeText={setInputText}
            placeholder="和静静说点什么..."
            placeholderTextColor="rgba(255, 255, 255, 0.3)"
            multiline
            maxLength={500}
            editable={!isTyping}
          />

          {/* 发送按钮 */}
          <TouchableOpacity
            style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
            onPress={handleSend}
            disabled={!inputText.trim() || isTyping}
          >
            <Text style={styles.sendText}>发送</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </RNAnimated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: SCREEN_HEIGHT,
    backgroundColor: 'rgba(15, 15, 26, 0.85)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(15, 15, 26, 0.92)',
  },
  handleContainer: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 6,
  },
  handle: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  topBarTitle: {
    fontSize: 15,
    color: 'rgba(255, 255, 255, 0.7)',
    fontWeight: '300',
  },
  closeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  closeText: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.5)',
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingVertical: 10,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    paddingBottom: 30,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
    backgroundColor: 'rgba(15, 15, 26, 0.9)',
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderRadius: 20,
    backgroundColor: 'rgba(26, 26, 46, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(58, 58, 94, 0.5)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: '#e0e0e0',
  },
  sendButton: {
    height: 40,
    paddingHorizontal: 20,
    borderRadius: 20,
    backgroundColor: '#e67e22',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: 'rgba(230, 126, 34, 0.3)',
  },
  sendText: {
    fontSize: 15,
    color: '#fff',
    fontWeight: '500',
  },
});
