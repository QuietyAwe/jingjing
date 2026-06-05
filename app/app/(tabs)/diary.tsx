import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Modal,
} from 'react-native';
import { useDiaryStore } from '../../stores/diary';
import { useOnboardingStore } from '../../stores/onboarding';
import { useHomeStore } from '../../stores/home';
import {
  getDiaries,
  generateDiary,
  likeDiary,
  addComment,
  getComments,
} from '../../services/diary';
import type { DiaryEntry, DiaryComment } from '../../services/diary';

export default function DiaryScreen() {
  const userId = useOnboardingStore((s) => s.userId);
  const timeOfDay = useHomeStore((s) => s.timeOfDay);
  const weatherText = useHomeStore((s) => s.weatherText);

  const {
    entries,
    comments,
    isLoading,
    page,
    hasMore,
    setEntries,
    appendEntries,
    addEntry,
    updateLikes,
    setComments,
    addComment: addCommentToStore,
    setLoading,
    setPage,
    setHasMore,
  } = useDiaryStore();

  const [commentModalDiaryId, setCommentModalDiaryId] = useState<number | null>(null);
  const [commentText, setCommentText] = useState('');

  // 加载日记
  const loadDiaries = useCallback(
    async (pageNum: number, refresh = false) => {
      if (!userId || isLoading) return;
      setLoading(true);
      try {
        const data = await getDiaries(userId, pageNum);
        if (refresh) {
          setEntries(data);
        } else {
          appendEntries(data);
        }
        setHasMore(data.length >= 10);
        setPage(pageNum);
      } catch (e) {
        console.error('加载日记失败', e);
      } finally {
        setLoading(false);
      }
    },
    [userId, isLoading],
  );

  // 首次加载
  useEffect(() => {
    if (userId) loadDiaries(1, true);
  }, [userId]);

  // 下拉刷新
  const handleRefresh = useCallback(() => {
    if (userId) loadDiaries(1, true);
  }, [userId, loadDiaries]);

  // 上拉加载更多
  const handleLoadMore = useCallback(() => {
    if (hasMore && !isLoading) loadDiaries(page + 1);
  }, [hasMore, isLoading, page, loadDiaries]);

  // 生成新日记
  const handleGenerate = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const entry = await generateDiary(userId, timeOfDay, weatherText);
      addEntry(entry);
    } catch (e) {
      Alert.alert('提示', '日记生成失败，请稍后再试');
    } finally {
      setLoading(false);
    }
  }, [userId, timeOfDay, weatherText]);

  // 点赞
  const handleLike = useCallback(async (diaryId: number) => {
    try {
      const result = await likeDiary(diaryId);
      updateLikes(diaryId, result.likes);
    } catch (e) {
      console.error('点赞失败', e);
    }
  }, []);

  // 打开评论
  const handleOpenComments = useCallback(async (diaryId: number) => {
    setCommentModalDiaryId(diaryId);
    setCommentText('');
    try {
      const data = await getComments(diaryId);
      setComments(diaryId, data);
    } catch (e) {
      console.error('加载评论失败', e);
    }
  }, []);

  // 提交评论
  const handleSubmitComment = useCallback(async () => {
    if (!commentModalDiaryId || !commentText.trim() || !userId) return;
    try {
      const comment = await addComment(commentModalDiaryId, userId, commentText.trim());
      addCommentToStore(commentModalDiaryId, comment);
      setCommentText('');
    } catch (e) {
      Alert.alert('提示', '评论失败');
    }
  }, [commentModalDiaryId, commentText, userId]);

  // 渲染日记卡片
  const renderDiaryCard = useCallback(
    ({ item }: { item: DiaryEntry }) => (
      <View style={styles.card}>
        {/* 配图标签（占位） */}
        {item.image_tag && (
          <View style={styles.imagePlaceholder}>
            <Text style={styles.imageTagText}>{item.image_tag}</Text>
          </View>
        )}

        {/* 正文 */}
        <Text style={styles.content}>{item.content}</Text>

        {/* 心情 + 时间 */}
        <View style={styles.metaRow}>
          {item.mood && <Text style={styles.moodTag}>{item.mood}</Text>}
          <Text style={styles.timeText}>{_formatTime(item.created_at)}</Text>
        </View>

        {/* 互动栏 */}
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => handleLike(item.id)}
          >
            <Text style={styles.actionIcon}>♥</Text>
            <Text style={styles.actionText}>{item.likes || 0}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => handleOpenComments(item.id)}
          >
            <Text style={styles.actionIcon}>💬</Text>
            <Text style={styles.actionText}>{item.comment_count || 0}</Text>
          </TouchableOpacity>
        </View>
      </View>
    ),
    [handleLike, handleOpenComments],
  );

  return (
    <View style={styles.container}>
      {/* 顶部标题 */}
      <View style={styles.header}>
        <Text style={styles.title}>镜像日记</Text>
        <TouchableOpacity style={styles.generateBtn} onPress={handleGenerate}>
          <Text style={styles.generateBtnText}>+ 生成日记</Text>
        </TouchableOpacity>
      </View>

      {/* 日记列表 */}
      <FlatList
        data={entries}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderDiaryCard}
        contentContainerStyle={styles.listContent}
        refreshing={isLoading && page === 1}
        onRefresh={handleRefresh}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>静静还没有写日记...</Text>
              <Text style={styles.emptyHint}>点击上方按钮让静静写一篇吧</Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          isLoading && page > 1 ? (
            <ActivityIndicator style={styles.loader} color="#8BA4B8" />
          ) : null
        }
      />

      {/* 评论弹窗 */}
      <Modal
        visible={commentModalDiaryId !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setCommentModalDiaryId(null)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalContent}>
            {/* 标题栏 */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>评论</Text>
              <TouchableOpacity onPress={() => setCommentModalDiaryId(null)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* 评论列表 */}
            <FlatList
              data={commentModalDiaryId ? comments[commentModalDiaryId] || [] : []}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <View style={styles.commentItem}>
                  <Text style={styles.commentContent}>{item.content}</Text>
                  <Text style={styles.commentTime}>{_formatTime(item.created_at)}</Text>
                </View>
              )}
              style={styles.commentList}
              ListEmptyComponent={
                <Text style={styles.emptyComment}>还没有评论~</Text>
              }
            />

            {/* 输入区 */}
            <View style={styles.commentInputRow}>
              <TextInput
                style={styles.commentInput}
                placeholder="说点什么..."
                placeholderTextColor="#666"
                value={commentText}
                onChangeText={setCommentText}
                multiline
              />
              <TouchableOpacity
                style={styles.sendBtn}
                onPress={handleSubmitComment}
              >
                <Text style={styles.sendBtnText}>发送</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function _formatTime(iso: string): string {
  const d = new Date(iso);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${h}:${m}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: '#E8E8E8',
  },
  generateBtn: {
    backgroundColor: 'rgba(139, 164, 184, 0.2)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(139, 164, 184, 0.3)',
  },
  generateBtnText: {
    color: '#8BA4B8',
    fontSize: 14,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 100,
  },
  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  imagePlaceholder: {
    height: 120,
    backgroundColor: 'rgba(139, 164, 184, 0.1)',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  imageTagText: {
    color: '#666',
    fontSize: 12,
  },
  content: {
    fontSize: 15,
    lineHeight: 24,
    color: '#D8D8D8',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 8,
  },
  moodTag: {
    fontSize: 12,
    color: '#8BA4B8',
    backgroundColor: 'rgba(139, 164, 184, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  timeText: {
    fontSize: 12,
    color: '#666',
  },
  actionRow: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 24,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionIcon: {
    fontSize: 16,
    color: '#8BA4B8',
  },
  actionText: {
    fontSize: 13,
    color: '#888',
  },
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 100,
  },
  emptyText: {
    fontSize: 16,
    color: '#666',
  },
  emptyHint: {
    fontSize: 13,
    color: '#555',
    marginTop: 8,
  },
  loader: {
    paddingVertical: 20,
  },
  // 评论弹窗
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#1e1e32',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#E8E8E8',
  },
  modalClose: {
    fontSize: 18,
    color: '#888',
    padding: 4,
  },
  commentList: {
    paddingHorizontal: 16,
    maxHeight: 300,
  },
  commentItem: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  commentContent: {
    fontSize: 14,
    color: '#D8D8D8',
    lineHeight: 20,
  },
  commentTime: {
    fontSize: 11,
    color: '#666',
    marginTop: 4,
  },
  emptyComment: {
    textAlign: 'center',
    color: '#555',
    paddingVertical: 30,
  },
  commentInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
    gap: 8,
  },
  commentInput: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    color: '#E8E8E8',
    maxHeight: 80,
  },
  sendBtn: {
    backgroundColor: 'rgba(139, 164, 184, 0.3)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  sendBtnText: {
    color: '#8BA4B8',
    fontSize: 14,
  },
});
