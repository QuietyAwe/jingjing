import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { checkCare } from '../services/care';
import { useOnboardingStore } from '../stores/onboarding';

// 配置通知行为
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * 主动关怀 Hook：
 * 1. 请求通知权限
 * 2. 定期检查关怀触发条件
 * 3. 本地推送关怀消息
 */
export function useCareCheck() {
  const userId = useOnboardingStore((s) => s.userId);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!userId) return;

    // 请求通知权限
    requestPermissions();

    // 立即检查一次
    runCareCheck(userId);

    // 每小时检查一次
    intervalRef.current = setInterval(() => {
      runCareCheck(userId);
    }, 60 * 60 * 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [userId]);

  const requestPermissions = async () => {
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        console.log('[CareCheck] Notification permission not granted');
      }
    } catch (e) {
      console.error('[CareCheck] Permission error:', e);
    }
  };

  const runCareCheck = async (uid: number) => {
    try {
      const result = await checkCare();
      if (result.total > 0) {
        // 发送本地通知
        const allMessages = [...result.daily_care, ...result.special_events];
        for (const item of allMessages) {
          await sendLocalNotification(item.message);
        }
      }
    } catch (e) {
      // 静默失败（后端未启动时不报错）
    }
  };

  const sendLocalNotification = async (message: string) => {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '静静想你了',
          body: message,
          sound: true,
        },
        trigger: null, // 立即发送
      });
    } catch (e) {
      console.error('[CareCheck] Notification error:', e);
    }
  };
}
