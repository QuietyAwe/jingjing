// ============================================================
// 好友私聊页（微信式两层导航的第三层：会话列表 → 好友私聊）
//
// 复用主聊天的气泡与输入条，但只有：好友人设 + 最近 feed + 该线程历史。
// 没有状态区/记忆区/灵光一闪/游戏区——配角不享用主角的全套拼装。
// 离开时留一条「聊过」的弱痕迹，内容本身不进主 AI 记忆。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ChatBubble, { StreamingBubble } from "@/components/ChatBubble";
import { InputBar } from "@/components/InputBar";
import { useChatStore } from "@/store/chatStore";
import { useTheme } from "@/theme/useTheme";
import { getFriendById } from "@/db/queries";
import { friendAvatarText } from "@/friends/persona";
import { buildFriendChatMessages, recordFriendChatTrace } from "@/friends/chat";
import { streamChat } from "@/llm/foreground";
import { hasApiKey } from "@/llm/client";
import { genMsgId } from "@/utils/id";
import { useAndroidKeyboard } from "@/utils/keyboard";
import { markFriendSeen } from "@/memory/unread";
import type { ChatMessage, FriendPersona } from "@/types/schema";

export default function FriendChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const { height: keyboardHeight, pad: keyboardPad } = useAndroidKeyboard();

  const friendId = Number(id);
  const [friend, setFriend] = useState<FriendPersona | null>(null);
  const [missing, setMissing] = useState(false);
  const [animatingMsgId, setAnimatingMsgId] = useState<string | null>(null);

  const rawMessages = useChatStore((s) => s.messages);
  const addMessage = useChatStore((s) => s.addMessage);
  const isLoading = useChatStore((s) => s.isLoading);
  const setLoading = useChatStore((s) => s.setLoading);
  const streamingText = useChatStore((s) => s.streamingText);
  const appendStreamingText = useChatStore((s) => s.appendStreamingText);
  const setStreamingText = useChatStore((s) => s.setStreamingText);

  const listRef = useRef<FlatList<ChatMessage>>(null);
  // 用 ref 保存好友，卸载回调里读得到最新值
  const friendRef = useRef<FriendPersona | null>(null);

  useEffect(() => {
    const f = Number.isFinite(friendId) ? getFriendById(friendId) : null;
    if (!f || f.is_active !== 1) {
      setMissing(true);
      return;
    }
    setFriend(f);
    friendRef.current = f;
  }, [friendId]);

  // 离开页面：留弱痕迹（好友私聊内容本身不进主记忆）
  useEffect(() => {
    return () => {
      const f = friendRef.current;
      if (f) recordFriendChatTrace(f);
    };
  }, []);

  const messages = useMemo(
    () => rawMessages.filter((m) => m.friend_id === friendId),
    [rawMessages, friendId]
  );

  // 进页面、以及页面内收到新消息，都视为已读
  useEffect(() => {
    if (Number.isFinite(friendId)) markFriendSeen(friendId);
  }, [friendId, messages.length]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  useEffect(() => {
    if (messages.length > 0) scrollToEnd();
  }, [messages.length, scrollToEnd]);

  const handleSend = useCallback(
    (text: string) => {
      const f = friendRef.current;
      if (!f || isLoading) return;

      if (!hasApiKey()) {
        Alert.alert("还没配置 API Key", "先在设置页填好 API Key，才能聊天。");
        return;
      }

      // 先拼上下文再落库：否则刚发的这条会同时出现在历史和当前输入里
      const payload = buildFriendChatMessages(f, text);

      const userMsg: ChatMessage = {
        id: genMsgId(),
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
        friend_id: f.id,
      };
      setAnimatingMsgId(userMsg.id);
      addMessage(userMsg);

      setLoading(true);
      setStreamingText("");

      streamChat(payload, {
        onDelta: (delta) => appendStreamingText(delta),
        onDone: (fullText) => {
          const replyMsg: ChatMessage = {
            id: genMsgId(),
            role: "assistant",
            content: fullText,
            timestamp: new Date().toISOString(),
            friend_id: f.id,
          };
          setAnimatingMsgId(replyMsg.id);
          addMessage(replyMsg);
          setStreamingText("");
          setLoading(false);
          scrollToEnd();
        },
        onError: (err: Error) => {
          addMessage({
            id: genMsgId(),
            role: "system",
            content: `${f.name} 没有回复：${err.message}`,
            timestamp: new Date().toISOString(),
            friend_id: f.id,
          });
          setStreamingText("");
          setLoading(false);
        },
      }).catch((err) => {
        console.error("[friend-chat] 发送异常:", err);
        setStreamingText("");
        setLoading(false);
      });
    },
    [addMessage, appendStreamingText, isLoading, scrollToEnd, setLoading, setStreamingText]
  );

  if (missing) {
    return (
      <View style={[styles.container, { backgroundColor: colors.bg, paddingTop: insets.top + 20 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backOnly}>
          <Text style={[styles.backText, { color: colors.accent }]}>‹ 返回</Text>
        </TouchableOpacity>
        <View style={styles.emptyWrap}>
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>这个人已经不在了</Text>
        </View>
      </View>
    );
  }

  const label = friend?.name ?? "";

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* 顶栏：返回 + 头像 + 名字/一句关系 */}
      <View style={[styles.header, { paddingTop: insets.top + 6, borderBottomColor: colors.border, backgroundColor: colors.sectionBg }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="返回会话列表"
        >
          <Ionicons name="chevron-back" size={20} color={colors.accent} />
          <Text style={[styles.backText, { color: colors.accent }]}>返回</Text>
        </TouchableOpacity>

        <View style={styles.headerMain}>
          <View style={[styles.headerAvatar, { backgroundColor: colors.accentMuted }]}>
            <Text style={styles.headerAvatarText}>{friend ? friendAvatarText(friend) : ""}</Text>
          </View>
          <View style={styles.headerTexts}>
            <Text style={[styles.headerName, { color: colors.text }]} numberOfLines={1}>
              {label}
            </Text>
            {friend?.summary ? (
              <Text style={[styles.headerSub, { color: colors.textMuted }]} numberOfLines={1}>
                {friend.summary}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.backBtn} />
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={[styles.listContent, { paddingBottom: 12 }]}
        renderItem={({ item }) => <ChatBubble message={item} shouldAnimate={item.id === animatingMsgId} />}
        onContentSizeChange={scrollToEnd}
        ListFooterComponent={
          isLoading && streamingText ? <StreamingBubble text={streamingText} /> : null
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Ionicons name="chatbubble-ellipses-outline" size={32} color={colors.textMuted} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {friend?.summary ? `${label} · ${friend.summary}` : `和${label}还没聊过`}
            </Text>
            <Text style={[styles.emptyHint, { color: colors.placeholder }]}>
              你们在朋友圈见过，还没单独说过话
            </Text>
          </View>
        }
      />

      <View style={{ paddingBottom: keyboardHeight > 0 ? 0 : insets.bottom }}>
        <InputBar onSend={handleSend} disabled={isLoading} hidePlus />
        {/* 键盘留白：占住键盘那块高度把输入框顶上去，缓动逐帧改高度 */}
        <Animated.View style={{ height: keyboardPad }} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 64,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
  },
  backText: {
    fontSize: 15,
    marginLeft: 1,
  },
  headerMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  headerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  headerAvatarText: {
    fontSize: 17,
  },
  headerTexts: {
    flexShrink: 1,
    marginLeft: 9,
    maxWidth: "70%",
  },
  headerName: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
  },
  headerSub: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 1,
  },
  listContent: {
    paddingTop: 10,
    paddingHorizontal: 0,
  },
  emptyWrap: {
    paddingTop: 88,
    alignItems: "center",
    paddingHorizontal: 32,
  },
  emptyText: {
    marginTop: 14,
    fontSize: 16,
    lineHeight: 23,
    textAlign: "center",
  },
  emptyHint: {
    marginTop: 8,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  backOnly: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
});
