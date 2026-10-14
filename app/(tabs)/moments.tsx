import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSettingsStore } from "@/store/settingsStore";
import { useTheme } from "@/theme/useTheme";
import { getMoments, getCommentsByMomentIds } from "@/db/queries";
import {
  postUserMoment,
  addComment,
  subscribeMomentUpdates,
  isAiTypingOn,
} from "@/moments/service";
import { MomentCard } from "@/components/MomentCard";
import { MomentComposer } from "@/components/MomentComposer";
import type { Moment, MomentComment, MoodTag } from "@/types/schema";

const PAGE_SIZE = 20;

/**
 * 心情动态页（类朋友圈）
 * feed 时间倒序；用户发帖/评论走 service（AI 互动由 service 异步补齐后订阅刷新）
 */
export default function MomentsScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const { ai_name } = useSettingsStore();

  const [items, setItems] = useState<Moment[]>([]);
  const [commentsMap, setCommentsMap] = useState<Record<number, MomentComment[]>>({});
  const [typingMap, setTypingMap] = useState<Record<number, boolean>>({});
  const [composerVisible, setComposerVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const aiLabel = ai_name || "私藏";

  /** 拉取最近 count 条动态及其评论（count 随分页增长，保持已加载深度） */
  const load = useCallback((count: number) => {
    const moments = getMoments(count);
    setItems(moments);
    const map = getCommentsByMomentIds(moments.map((m) => m.id));
    const nextComments: Record<number, MomentComment[]> = {};
    const nextTyping: Record<number, boolean> = {};
    for (const m of moments) {
      nextComments[m.id] = map.get(m.id) ?? [];
      nextTyping[m.id] = isAiTypingOn(m.id);
    }
    setCommentsMap(nextComments);
    setTypingMap(nextTyping);
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
          style={[styles.composeBtn, { backgroundColor: colors.accentMuted, borderColor: colors.accent }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={[styles.composeBtnText, { color: colors.accent }]}>＋</Text>
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
            aiTyping={typingMap[item.id]}
            onSendComment={addComment}
          />
        )}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} />
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textMuted }]}>
              还没有动态，发第一条吧
            </Text>
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
    paddingBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: 1,
  },
  composeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  composeBtnText: {
    fontSize: 20,
    lineHeight: 22,
  },
  listContent: {
    paddingHorizontal: 16,
  },
  empty: {
    paddingTop: 120,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
  },
});
