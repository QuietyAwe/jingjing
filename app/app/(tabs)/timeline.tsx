import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  FlatList,
  Modal,
  TextInput,
} from 'react-native';
import { useOnboardingStore } from '../../stores/onboarding';
import {
  getMemoryCards,
  getMemoryContext,
  sendGift,
  backupData,
  exportTimeline,
} from '../../services/timeline';
import type { MemoryCard } from '../../services/timeline';

const GIFT_OPTIONS = [
  { type: 'flower', icon: '🌸', name: '一束花' },
  { type: 'star', icon: '⭐', name: '一颗星星' },
  { type: 'moon', icon: '🌙', name: '一轮月亮' },
  { type: 'cake', icon: '🎂', name: '一块蛋糕' },
  { type: 'letter', icon: '💌', name: '一封信' },
];

const CATEGORY_LABELS: Record<string, string> = {
  preference: '偏好',
  habit: '习惯',
  emotion: '情感',
  fact: '事实',
  gift: '礼物',
  general: '记忆',
};

export default function TimelineScreen() {
  const userId = useOnboardingStore((s) => s.userId);
  const [memories, setMemories] = useState<MemoryCard[]>([]);
  const [selectedMemory, setSelectedMemory] = useState<MemoryCard | null>(null);
  const [contextMessages, setContextMessages] = useState<any[]>([]);
  const [showGiftModal, setShowGiftModal] = useState(false);
  const [giftMessage, setGiftMessage] = useState('');
  const [activeSection, setActiveSection] = useState<'gallery' | 'gift' | 'backup'>('gallery');

  // 加载记忆
  useEffect(() => {
    if (userId) loadMemories();
  }, [userId]);

  const loadMemories = async () => {
    try {
      const data = await getMemoryCards(userId!);
      setMemories(data);
    } catch (e) {
      console.error('加载记忆失败', e);
    }
  };

  // 查看记忆上下文
  const handleMemoryPress = useCallback(async (card: MemoryCard) => {
    setSelectedMemory(card);
    try {
      const ctx = await getMemoryContext(userId!, card.id);
      setContextMessages(ctx.context_messages || []);
    } catch (e) {
      setContextMessages([]);
    }
  }, [userId]);

  // 送礼物
  const handleSendGift = useCallback(async (giftType: string) => {
    try {
      const result = await sendGift(userId!, giftType, giftMessage);
      Alert.alert('✨', result.message);
      setShowGiftModal(false);
      setGiftMessage('');
      loadMemories(); // 刷新记忆（礼物会写入语义记忆）
    } catch (e) {
      Alert.alert('提示', '礼物发送失败');
    }
  }, [userId, giftMessage]);

  // 数据备份
  const handleBackup = useCallback(async () => {
    try {
      const result = await backupData(userId!);
      Alert.alert('备份完成', result.message);
    } catch (e) {
      Alert.alert('提示', '备份失败');
    }
  }, [userId]);

  // 导出
  const handleExport = useCallback(async () => {
    try {
      const data = await exportTimeline(userId!);
      Alert.alert(
        '导出数据',
        `用户：${data.user_name}\n记忆：${data.memories.length} 条\n对话：${data.recent_messages.length} 条\n\n（生产环境将生成长图/PDF）`,
      );
    } catch (e) {
      Alert.alert('提示', '导出失败');
    }
  }, [userId]);

  return (
    <View style={styles.container}>
      {/* 顶部标题 */}
      <View style={styles.header}>
        <Text style={styles.title}>时空</Text>
      </View>

      {/* Section 切换 */}
      <View style={styles.sectionTabs}>
        {[
          { key: 'gallery', label: '记忆回廊' },
          { key: 'gift', label: '跨时空信箱' },
          { key: 'backup', label: '数据' },
        ].map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.sectionTab, activeSection === tab.key && styles.sectionTabActive]}
            onPress={() => setActiveSection(tab.key as any)}
          >
            <Text style={[styles.sectionTabText, activeSection === tab.key && styles.sectionTabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* 记忆回廊 */}
      {activeSection === 'gallery' && (
        <FlatList
          data={memories}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.memoryCard} onPress={() => handleMemoryPress(item)}>
              <View style={styles.memoryHeader}>
                <Text style={styles.memoryCategory}>
                  {CATEGORY_LABELS[item.category] || item.category}
                </Text>
              </View>
              <Text style={styles.memoryContent}>{item.content}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>还没有记忆...</Text>
              <Text style={styles.emptyHint}>和静静聊天会自动提取记忆哦</Text>
            </View>
          }
        />
      )}

      {/* 跨时空信箱 */}
      {activeSection === 'gift' && (
        <ScrollView contentContainerStyle={styles.giftContainer}>
          <Text style={styles.giftTitle}>送给静静一份礼物</Text>
          <Text style={styles.giftSubtitle}>静静会在聊天中提到你送的礼物~</Text>

          <View style={styles.giftGrid}>
            {GIFT_OPTIONS.map((gift) => (
              <TouchableOpacity
                key={gift.type}
                style={styles.giftItem}
                onPress={() => handleSendGift(gift.type)}
              >
                <Text style={styles.giftIcon}>{gift.icon}</Text>
                <Text style={styles.giftName}>{gift.name}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* 附言 */}
          <TextInput
            style={styles.giftInput}
            placeholder="附言给静静...（可选）"
            placeholderTextColor="#555"
            value={giftMessage}
            onChangeText={setGiftMessage}
            multiline
          />
        </ScrollView>
      )}

      {/* 数据管理 */}
      {activeSection === 'backup' && (
        <ScrollView contentContainerStyle={styles.backupContainer}>
          <TouchableOpacity style={styles.backupBtn} onPress={handleBackup}>
            <Text style={styles.backupBtnIcon}>☁️</Text>
            <View>
              <Text style={styles.backupBtnTitle}>记忆云同步</Text>
              <Text style={styles.backupBtnDesc}>备份语义记忆和情景记忆</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity style={styles.backupBtn} onPress={handleExport}>
            <Text style={styles.backupBtnIcon}>📤</Text>
            <View>
              <Text style={styles.backupBtnTitle}>时空日志导出</Text>
              <Text style={styles.backupBtnDesc}>导出记忆和对话数据</Text>
            </View>
          </TouchableOpacity>

          <View style={styles.infoCard}>
            <Text style={styles.infoText}>
              💡 云同步会将你的记忆数据加密备份到云端。换设备登录后可恢复记忆。
            </Text>
          </View>
        </ScrollView>
      )}

      {/* 记忆详情弹窗 */}
      <Modal
        visible={selectedMemory !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setSelectedMemory(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>记忆详情</Text>
              <TouchableOpacity onPress={() => setSelectedMemory(null)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {selectedMemory && (
              <ScrollView style={styles.modalBody}>
                <Text style={styles.modalMemoryContent}>{selectedMemory.content}</Text>
                <Text style={styles.modalCategory}>
                  分类：{CATEGORY_LABELS[selectedMemory.category] || selectedMemory.category}
                </Text>

                {contextMessages.length > 0 && (
                  <>
                    <Text style={styles.contextTitle}>相关对话</Text>
                    {contextMessages.map((msg, i) => (
                      <View key={i} style={styles.contextMsg}>
                        <Text style={styles.contextRole}>
                          {msg.role === 'user' ? '你' : '静静'}
                        </Text>
                        <Text style={styles.contextContent}>{msg.content}</Text>
                      </View>
                    ))}
                  </>
                )}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: '#E8E8E8',
  },
  sectionTabs: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginBottom: 12,
    gap: 8,
  },
  sectionTab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  sectionTabActive: {
    backgroundColor: 'rgba(230, 126, 34, 0.2)',
  },
  sectionTabText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
  },
  sectionTabTextActive: {
    color: '#e67e22',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 100,
  },
  memoryCard: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  memoryHeader: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  memoryCategory: {
    fontSize: 11,
    color: '#8BA4B8',
    backgroundColor: 'rgba(139, 164, 184, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  memoryContent: {
    fontSize: 14,
    color: '#D8D8D8',
    lineHeight: 20,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 80,
  },
  emptyText: {
    fontSize: 16,
    color: '#666',
  },
  emptyHint: {
    fontSize: 13,
    color: '#555',
    marginTop: 6,
  },
  // 礼物
  giftContainer: {
    paddingHorizontal: 20,
    paddingBottom: 100,
  },
  giftTitle: {
    fontSize: 18,
    fontWeight: '500',
    color: '#E8E8E8',
    marginBottom: 4,
  },
  giftSubtitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.4)',
    marginBottom: 24,
  },
  giftGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 20,
  },
  giftItem: {
    width: '30%',
    aspectRatio: 1,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  giftIcon: {
    fontSize: 32,
    marginBottom: 6,
  },
  giftName: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.6)',
  },
  giftInput: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    color: '#D8D8D8',
    minHeight: 60,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  // 备份
  backupContainer: {
    paddingHorizontal: 20,
    paddingBottom: 100,
    gap: 12,
  },
  backupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 16,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  backupBtnIcon: {
    fontSize: 28,
  },
  backupBtnTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: '#E8E8E8',
  },
  backupBtnDesc: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    marginTop: 2,
  },
  infoCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 12,
    padding: 14,
    marginTop: 8,
  },
  infoText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.3)',
    lineHeight: 18,
  },
  // 弹窗
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
  modalBody: {
    padding: 16,
  },
  modalMemoryContent: {
    fontSize: 16,
    color: '#E8E8E8',
    lineHeight: 24,
    marginBottom: 8,
  },
  modalCategory: {
    fontSize: 12,
    color: '#8BA4B8',
    marginBottom: 20,
  },
  contextTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.6)',
    marginBottom: 10,
  },
  contextMsg: {
    marginBottom: 8,
  },
  contextRole: {
    fontSize: 12,
    color: '#8BA4B8',
    marginBottom: 2,
  },
  contextContent: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    lineHeight: 18,
  },
});
