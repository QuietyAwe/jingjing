import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSettingsStore } from "@/store/settingsStore";
import { useTheme } from "@/theme/useTheme";
import { getMoments, getCommentsByMomentIds, getAllFriends, setFriendActive } from "@/db/queries";
import { notifyMomentUpdates } from "@/moments/bus";
import { markMomentsSeen } from "@/moments/seen";
import { markMomentsSeenAt } from "@/memory/unread";
import { useUnreadStore } from "@/store/unreadStore";
import {
  postUserMoment,
  addComment,
  subscribeMomentUpdates,
  isAiTypingOn,
} from "@/moments/service";
import { MomentCard } from "@/components/MomentCard";
import { MomentComposer } from "@/components/MomentComposer";
import type { Moment, MomentComment, MoodTag, FriendPersona } from "@/types/schema";

const PAGE_SIZE = 20;

/**
 * 心情动态页（类朋友圈）
 * feed 时间倒序；用户发帖/评论走 service（AI 互动由 service 异步补齐后订阅刷新）
 */
export default function MomentsScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { ai_name } = useSettingsStore();

  const [items, setItems] = useState<Moment[]>([]);
  const [commentsMap, setCommentsMap] = useState<Record<number, MomentComment[]>>({});
  const [typingMap, setTypingMap] = useState<Record<number, boolean>>({});
  const [friendMap, setFriendMap] = useState<Record<number, FriendPersona>>({});
  const [composerVisible, setComposerVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const aiLabel = ai_name || "私藏";

  /** 拉取最近 count 条动态及其评论（count 随分页增长，保持已加载深度） */
  const load = useCallback((count: number) => {
    const moments = getMoments(count);
    setItems(moments);
    // 记下「用户刚看到这些帖子」：灵光一闪对这些帖子提高触发概率
    markMomentsSeen(moments.map((m) => m.id));
    // 已读到此刻：Tab 角标清掉
    markMomentsSeenAt();
    useUnreadStore.getState().setMomentsUnread(false);
    const map = getCommentsByMomentIds(moments.map((m) => m.id));
    const nextComments: Record<number, MomentComment[]> = {};
    const nextTyping: Record<number, boolean> = {};
    for (const m of moments) {
      nextComments[m.id] = map.get(m.id) ?? [];
      nextTyping[m.id] = isAiTypingOn(m.id);
    }
    setCommentsMap(nextComments);
    setTypingMap(nextTyping);

    // 好友档案：feed 里好友动态/评论都靠它署名（含停用的，历史内容还要能显示名字）
    const friends = getAllFriends();
    const nextFriends: Record<number, FriendPersona> = {};
    for (const f of friends) nextFriends[f.id] = f;
    setFriendMap(nextFriends);
  }, []);

  // 首次加载 + 订阅 AI 发帖/评论落库后的刷新
  useEffect(() => {
    load(PAGE_SIZE);
    return subscribeMomentUpdates(() => {
      load(Math.max(items.length, PAGE_SIZE));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load(Math.max(items.length, PAGE_SIZE));
    setRefreshing(false);
  }, [items.length, load]);

  const loadMore = useCallback(() => {
    if (items.length < PAGE_SIZE) return;
    load(items.length + PAGE_SIZE);
  }, [items.length, load]);

  const handlePublish = useCallback(
    (content: string, mood: MoodTag) => {
      postUserMoment(content, mood);
    },
    []
  );

  /** 长按好友头像/评论：一键让 ta 不再出现（停用，不洗记忆） */
  const handleBlockFriend = useCallback(
    (friendId: number) => {
      const f = friendMap[friendId];
      Alert.alert(
        "不再让 ta 出现？",
        `${f?.name ?? "这个人"} 以后不会再发动态、评论，也不会出现在会话列表里。以前认识过的事不会被抹掉。`,
        [
          { text: "取消", style: "cancel" },
          {
            text: "不再出现",
            style: "destructive",
            onPress: () => {
              setFriendActive(friendId, false);
              notifyMomentUpdates();
            },
          },
        ]
      );
    },
    [friendMap]
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* 顶部栏：标题 + 发帖入口 */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 10,
            backgroundColor: colors.bg,
          },
        ]}
      >
        <Text style={[styles.title, { color: colors.text }]}>动态</Text>
        <TouchableOpacity
          onPress={() => setComposerVisible(true)}
          style={[styles.composeBtn, { backgroundColor: colors.accentMuted }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="发布新动态"
        >
          <Ionicons name="add" size={25} color={colors.accent} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={items}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: insets.bottom + 24 },
        ]}
        renderItem={({ item }) => (
          <MomentCard
            moment={item}
            comments={commentsMap[item.id] ?? []}
            aiLabel={aiLabel}
            friendMap={friendMap}
            aiTyping={typingMap[item.id]}
            onSendComment={addComment}
            onOpenFriend={(friendId) => router.push(`/friend/${friendId}`)}
            onBlockFriend={handleBlockFriend}
          />
        )}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} />
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="partly-sunny-outline" size={36} color={colors.textMuted} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              这里还很安静，记录此刻的心情吧
            </Text>
            <TouchableOpacity
              style={[styles.emptyAction, { backgroundColor: colors.accent }]}
              onPress={() => setComposerVisible(true)}
              accessibilityRole="button"
              accessibilityLabel="发布第一条动态"
            >
              <Text style={[styles.emptyActionText, { color: colors.accentText }]}>记录此刻</Text>
            </TouchableOpacity>
          </View>
        }
      />

      <MomentComposer
        visible={composerVisible}
        onClose={() => setComposerVisible(false)}
        onSubmit={handlePublish}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: 14,
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  composeBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 2,
  },
  empty: {
    paddingTop: 128,
    alignItems: "center",
    paddingHorizontal: 32,
  },
  emptyText: {
    marginTop: 14,
    fontSize: 16,
    lineHeight: 23,
    textAlign: "center",
  },
  emptyAction: {
    minHeight: 44,
    justifyContent: "center",
    marginTop: 22,
    borderRadius: 16,
    paddingHorizontal: 22,
    paddingVertical: 11,
  },
  emptyActionText: {
    fontSize: 15,
    fontWeight: "600",
  },
});
