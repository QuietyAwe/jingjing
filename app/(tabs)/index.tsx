import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import dayjs from "dayjs";
import { useChatStore } from "@/store/chatStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useTheme } from "@/theme/useTheme";
import { getDebutedFriends } from "@/db/queries";
import { friendAvatarText } from "@/friends/persona";

/** 按时段打招呼（只给时段感，不报精确时间） */
function greeting(hour: number): string {
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

/** 会话条右上角的时间：今天显时分，昨天显「昨天」，更早显日期 */
function formatTime(iso: string): string {
  const d = dayjs(iso);
  const now = dayjs();
  if (d.isSame(now, "day")) return d.format("HH:mm");
  if (d.isSame(now.subtract(1, "day"), "day")) return "昨天";
  return d.format("MM-DD");
}

/** 最后一条消息预览：压平换行、截断 */
function previewText(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/**
 * 一级会话列表页（微信式两层导航的第一层）
 * v1 只有一位联系人（AI），结构上预留多联系人扩展位。
 * 点会话条推入二级聊天页 /chat。
 */
export default function ConversationListScreen() {
  const router = useRouter();
  const colors = useTheme();
  const insets = useSafeAreaInsets();

  const messages = useChatStore((s) => s.messages);
  const { ai_name, user_nickname, loadApiKey } = useSettingsStore();
  // 好友到登场时间不一定伴随状态变化：回到列表页时重算一次
  const [, setFocusTick] = useState(0);

  useEffect(() => {
    loadApiKey();
  }, []);

  useFocusEffect(
    useCallback(() => {
      setFocusTick((v) => v + 1);
    }, [])
  );

  const aiLabel = ai_name || "私藏";
  // 主会话只看主聊天：好友私聊各有自己的线程
  const mainMessages = messages.filter((m) => !m.friend_id);
  const lastMessage = mainMessages.length > 0 ? mainMessages[mainMessages.length - 1] : null;

  // 好友入口：登场之后才出现，按最近一条私聊排序（没聊过的排在后面）
  const friendRows = getDebutedFriends()
    .map((f) => {
      const thread = messages.filter((m) => m.friend_id === f.id);
      return { friend: f, last: thread.length > 0 ? thread[thread.length - 1] : null };
    })
    .sort((a, b) => {
      const ta = a.last ? dayjs(a.last.timestamp).valueOf() : 0;
      const tb = b.last ? dayjs(b.last.timestamp).valueOf() : 0;
      return tb - ta;
    });

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + 16 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* 顶部：大标题 + 时段问候 */}
        <View style={styles.headerBlock}>
          <Text style={[styles.title, { color: colors.text }]}>私藏</Text>
          <Text style={[styles.greeting, { color: colors.textMuted }]}>
            {greeting(new Date().getHours())}
            {user_nickname ? `，${user_nickname}` : ""}
          </Text>
        </View>

        {/* 会话条：AI 的名字横向一小条 */}
        <Pressable
          onPress={() => router.push("/chat")}
          style={({ pressed }) => [
            styles.chatRow,
            {
              backgroundColor: colors.sectionBg,
              borderColor: colors.border,
              transform: [{ scale: pressed ? 0.985 : 1 }],
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <View style={[styles.avatar, { backgroundColor: colors.accent }]}>
            <Text style={styles.avatarText}>{aiLabel.slice(0, 1)}</Text>
          </View>
          <View style={styles.chatRowMain}>
            <View style={styles.chatRowTop}>
              <Text
                style={[styles.chatName, { color: colors.text }]}
                numberOfLines={1}
              >
                {aiLabel}
              </Text>
              {lastMessage ? (
                <Text style={[styles.chatTime, { color: colors.textMuted }]}>
                  {formatTime(lastMessage.timestamp)}
                </Text>
              ) : null}
            </View>
            <Text
              style={[styles.chatPreview, { color: colors.textMuted }]}
              numberOfLines={1}
            >
              {lastMessage
                ? previewText(lastMessage.content)
                : "你们还没有聊过天，点开打个招呼吧"}
            </Text>
          </View>
        </Pressable>

        {/* 好友：登场之后才出现在会话列表；点头像进私聊 */}
        {friendRows.length > 0 ? (
          <>
            <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>朋友</Text>
            {friendRows.map(({ friend, last }) => (
              <Pressable
                key={friend.id}
                onPress={() => router.push(`/friend/${friend.id}`)}
                style={({ pressed }) => [
                  styles.chatRow,
                  styles.friendRow,
                  {
                    backgroundColor: colors.sectionBg,
                    borderColor: colors.border,
                    transform: [{ scale: pressed ? 0.985 : 1 }],
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <View style={[styles.avatar, { backgroundColor: colors.accentMuted }]}>
                  <Text style={styles.avatarEmoji}>{friendAvatarText(friend)}</Text>
                </View>
                <View style={styles.chatRowMain}>
                  <View style={styles.chatRowTop}>
                    <Text style={[styles.chatName, { color: colors.text }]} numberOfLines={1}>
                      {friend.name}
                    </Text>
                    {last ? (
                      <Text style={[styles.chatTime, { color: colors.textMuted }]}>
                        {formatTime(last.timestamp)}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={[styles.chatPreview, { color: colors.textMuted }]} numberOfLines={1}>
                    {last
                      ? previewText(last.content)
                      : friend.summary || "在朋友圈见过，还没单独聊过"}
                  </Text>
                </View>
              </Pressable>
            ))}
          </>
        ) : null}

        {/* 扩展位：后续支持更多联系人 */}
        <View style={[styles.placeholderRow, { borderColor: colors.border }]}>
          <Text style={[styles.placeholderText, { color: colors.textMuted }]}>
            以后可以添加更多联系人
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  headerBlock: {
    marginBottom: 20,
    paddingHorizontal: 4,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: 1,
  },
  greeting: {
    marginTop: 6,
    fontSize: 13,
  },
  chatRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "600",
  },
  avatarEmoji: {
    fontSize: 22,
  },
  sectionLabel: {
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
    fontSize: 12,
    letterSpacing: 1,
  },
  friendRow: {
    marginTop: 10,
  },
  chatRowMain: {
    flex: 1,
    marginLeft: 12,
  },
  chatRowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  chatName: {
    flex: 1,
    fontSize: 17,
    fontWeight: "500",
  },
  chatTime: {
    fontSize: 12,
    marginLeft: 8,
  },
  chatPreview: {
    marginTop: 4,
    fontSize: 14,
    lineHeight: 20,
  },
  placeholderRow: {
    marginTop: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: "dashed",
    paddingVertical: 18,
    paddingHorizontal: 14,
    alignItems: "center",
    opacity: 0.55,
  },
  placeholderText: {
    fontSize: 13,
  },
});
