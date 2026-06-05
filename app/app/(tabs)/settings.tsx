import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
} from 'react-native';
import { useOnboardingStore } from '../../stores/onboarding';
import { useSettingsStore } from '../../stores/settings';
import { apiRequest } from '../../services/api';

export default function SettingsScreen() {
  const { userId, callName } = useOnboardingStore();
  const {
    ttsVolume, ambientVolume, darkMode, dynamicEffects, careMode,
    setTtsVolume, setAmbientVolume, setDarkMode, setDynamicEffects, setCareMode,
  } = useSettingsStore();

  // 加载设置
  useEffect(() => {
    if (userId) {
      apiRequest<any>(`/api/settings/${userId}`).then((data) => {
        useSettingsStore.getState().loadFromServer({
          ttsVolume: data.tts_volume,
          ambientVolume: data.ambient_volume,
          darkMode: data.dark_mode,
          dynamicEffects: data.dynamic_effects,
          careMode: data.care_mode,
        });
      }).catch(() => {});
    }
  }, [userId]);

  const updateSetting = async (key: string, value: any) => {
    if (!userId) return;
    try {
      await apiRequest(`/api/settings/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ [key]: value }),
      });
    } catch (e) {
      console.error('Failed to update setting:', e);
    }
  };

  const handleResetMemory = (mode: 'soft' | 'hard') => {
    const title = mode === 'soft' ? '软重置' : '硬重置';
    const message = mode === 'soft'
      ? '确认要让静静忘记最近的对话吗？语义记忆（你的基本信息）会保留。'
      : '确认要让静静忘记关于你的一切吗？此操作不可逆。';

    Alert.alert(title, message, [
      { text: '取消', style: 'cancel' },
      {
        text: '确认',
        style: 'destructive',
        onPress: async () => {
          try {
            await apiRequest(`/api/settings/${userId}/reset-memory?mode=${mode}`, { method: 'POST' });
            Alert.alert('完成', mode === 'soft' ? '静静有些困惑...但还记得你的名字...' : '静静完全不记得你了...');
          } catch (e) {
            Alert.alert('错误', '操作失败，请重试');
          }
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>设置</Text>

      {/* 声音设置 */}
      <Text style={styles.sectionTitle}>声音</Text>
      <SettingRow label="静静语音音量" value={`${Math.round(ttsVolume * 100)}%`} />
      <SettingRow label="环境底噪" value={`${Math.round(ambientVolume * 100)}%`} />

      {/* 视效设置 */}
      <Text style={styles.sectionTitle}>视效</Text>
      <SettingRow label="深色模式" value={darkModeLabels[darkMode]} onPress={() => {
        const modes: Array<typeof darkMode> = ['system', 'light', 'dark', 'sync'];
        const next = modes[(modes.indexOf(darkMode) + 1) % modes.length];
        setDarkMode(next);
        updateSetting('dark_mode', next);
      }} />
      <SettingRow label="动态视效">
        <Switch
          value={dynamicEffects}
          onValueChange={(v) => { setDynamicEffects(v); updateSetting('dynamic_effects', v); }}
          trackColor={{ true: '#e67e22', false: '#3a3a5e' }}
        />
      </SettingRow>

      {/* 通讯频率 */}
      <Text style={styles.sectionTitle}>通讯频率</Text>
      <View style={styles.careModeRow}>
        {(['clingy', 'normal', 'dnd'] as const).map((mode) => (
          <TouchableOpacity
            key={mode}
            style={[styles.careModeButton, careMode === mode && styles.careModeActive]}
            onPress={() => { setCareMode(mode); updateSetting('care_mode', mode); }}
          >
            <Text style={[styles.careModeText, careMode === mode && styles.careModeTextActive]}>
              {careModeLabels[mode]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* 记忆重置 */}
      <Text style={styles.sectionTitle}>记忆管理</Text>
      <TouchableOpacity style={styles.resetButton} onPress={() => handleResetMemory('soft')}>
        <Text style={styles.resetText}>软重置（清除近期对话记忆）</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.resetButton, styles.resetButtonDanger]} onPress={() => handleResetMemory('hard')}>
        <Text style={[styles.resetText, styles.resetTextDanger]}>硬重置（清除所有记忆）</Text>
      </TouchableOpacity>

      {/* 账号信息 */}
      <Text style={styles.sectionTitle}>账号</Text>
      <SettingRow label="称呼" value={callName === 'gege' ? '哥哥' : '姐姐'} />
      <SettingRow label="手机号" value="未绑定" />

      <View style={styles.footer}>
        <Text style={styles.footerText}>晚安静静 v0.1.0</Text>
      </View>
    </ScrollView>
  );
}

function SettingRow({ label, value, onPress, children }: {
  label: string; value?: string; onPress?: () => void; children?: React.ReactNode;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={onPress ? 0.6 : 1}>
      <Text style={styles.rowLabel}>{label}</Text>
      {children || <Text style={styles.rowValue}>{value}</Text>}
    </TouchableOpacity>
  );
}

const darkModeLabels: Record<string, string> = {
  system: '跟随系统', light: '强制浅色', dark: '强制深色', sync: '晨昏同步',
};
const careModeLabels: Record<string, string> = {
  clingy: '黏人', normal: '克制', dnd: '勿扰',
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  content: { paddingHorizontal: 20, paddingTop: 60, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '200', color: '#e0e0e0', marginBottom: 30, letterSpacing: 4 },
  sectionTitle: { fontSize: 13, color: '#8a8aaa', letterSpacing: 2, marginTop: 24, marginBottom: 10 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  rowLabel: { fontSize: 15, color: '#d0d0e0' },
  rowValue: { fontSize: 14, color: '#8a8aaa' },
  careModeRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  careModeButton: {
    flex: 1, paddingVertical: 10, borderRadius: 20,
    backgroundColor: 'rgba(26,26,46,0.8)', borderWidth: 1, borderColor: 'rgba(58,58,94,0.5)', alignItems: 'center',
  },
  careModeActive: { backgroundColor: 'rgba(230,126,34,0.2)', borderColor: '#e67e22' },
  careModeText: { fontSize: 14, color: '#8a8aaa' },
  careModeTextActive: { color: '#e67e22' },
  resetButton: {
    paddingVertical: 14, borderRadius: 12, backgroundColor: 'rgba(26,26,46,0.8)',
    borderWidth: 1, borderColor: 'rgba(58,58,94,0.5)', alignItems: 'center', marginTop: 8,
  },
  resetButtonDanger: { borderColor: 'rgba(200,50,50,0.5)' },
  resetText: { fontSize: 14, color: '#d0d0e0' },
  resetTextDanger: { color: '#e06060' },
  footer: { marginTop: 40, alignItems: 'center' },
  footerText: { fontSize: 12, color: '#5a5a7a' },
});
