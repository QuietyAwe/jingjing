// ============================================================
// 聊天气泡组件 — 深色气泡(用户) / 浅灰气泡(AI)
// 长按触发 onLongPress 回调
// ============================================================

import { View, Text, StyleSheet, Pressable } from "react-native";
import type { ChatMessage } from "@/types/schema";
import { useTheme, useCurrentCustomColors } from "@/theme/useTheme";
import { useState, useMemo, useEffect } from "react";
import { useSettingsStore } from "@/store/settingsStore";

import { splitForChat, revealStepMs } from "@/utils/text";

interface Props {
  message: ChatMessage;
  onLongPress?: () => void;
  /** 非流式模式下对该消息做逐条延迟动画 */
  shouldAnimate?: boolean;
  /** 每显示一条新气泡时回调（用于自动滚底） */
  onBubbleAppear?: () => void;
}

/**
 * 已播过「逐条出现」动画的消息 id：同一条消息只播一次。
 * 列表窗口滚动、游戏卡折叠/展开都会让气泡重挂载，重播会看到
 * 「闪现全文 → 突然消失 → 再逐条出现」的跳变，所以重挂载直接显示全文。
 */
const revealedMsgIds = new Set<string>();

export default function ChatBubble({ message, onLongPress, shouldAnimate, onBubbleAppear }: Props) {
  const isUser = message.role === "user";
  const colors = useTheme();
  const customColors = useCurrentCustomColors();
  const [pressed, setPressed] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  // 系统提示：居中小字，不参与交互
  if (message.role === "system") {
    return (
      <View style={styles.systemRow}>
        <Text style={[styles.systemText, { color: colors.textMuted }]}>{message.content}</Text>
      </View>
    );
  }

  // AI 消息按段落分割成多个气泡（模拟真人聊天风格）
  const paragraphs = useMemo(
    () => isUser ? [message.content] : splitForChat(message.content),
    [isUser, message.content]
  );

  // 非流式模式：按字数逐条延迟显示。首帧即锁定决策——
  // 要播就从第 1 段开始生长，绝不先渲染全文再回退（那是用户看到的「闪现」）
  const shouldDelay =
    !isUser && !!shouldAnimate && paragraphs.length > 1 && !revealedMsgIds.has(message.id);
  const [visibleCount, setVisibleCount] = useState(shouldDelay ? 1 : paragraphs.length);
  useEffect(() => {
    // 挂载即标记已播过：之后重挂载（窗口滚动/卡片展开）直接显示全文，不重播
    revealedMsgIds.add(message.id);
    if (!shouldDelay) {
      // 非动画模式也要通知列表（否则 AI 发消息后不会滚到底）
      onBubbleAppear?.();
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    let acc = 0;
    for (let i = 1; i < paragraphs.length; i++) {
      // 按字数计算延迟：每字 50ms，范围 500ms ~ 3000ms（与 revealStepMs 同口径，
      // 自动聚焦要等这段动画播完，两处节奏不能漂移）
      const delay = revealStepMs(paragraphs[i - 1]);
      acc += delay;
      timers.push(setTimeout(() => {
        setVisibleCount(i + 1);
        onBubbleAppear?.();
      }, acc));
    }
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id]);

  const bubbleContent = (
    <>
      {/* 思考过程（仅 AI 消息且有 thinking 内容） */}
      {!isUser && message.thinking && (
        <View style={[styles.thinkingRow]}>
          <Pressable
            style={[styles.thinkingToggle, { backgroundColor: colors.bg, borderColor: colors.border }]}
            onPress={() => setThinkingExpanded(!thinkingExpanded)}
          >
            <Text style={[styles.thinkingToggleText, { color: colors.textMuted }]}>
              {thinkingExpanded ? "▾ 收起思考" : "▸ 查看思考"}
            </Text>
          </Pressable>
          {thinkingExpanded && (
            <View style={[styles.thinkingBubble, { backgroundColor: colors.bg, borderColor: colors.border }]}>
              <Text style={[styles.thinkingText, { color: colors.textMuted }]}>{message.thinking}</Text>
            </View>
          )}
        </View>
      )}

      {paragraphs.slice(0, visibleCount).map((para, index) => (
        <Pressable
          key={index}
          onLongPress={onLongPress}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          delayLongPress={400}
          style={[
            styles.row,
            isUser ? styles.rowRight : styles.rowLeft,
          ]}
        >
          <View
            style={[
              styles.bubble,
              isUser
                ? { backgroundColor: colors.bubbleUser }
                : { backgroundColor: colors.bubbleAi, borderWidth: 1, borderColor: colors.border },
              // 连续气泡做视觉分组：相邻两边用小圆角，看起来像一叠卡片而不是散落的块
              index < visibleCount - 1 && (isUser
                ? { borderBottomRightRadius: 6 }
                : { borderBottomLeftRadius: 6 }),
              index > 0 && (isUser
                ? { borderTopRightRadius: 6 }
                : { borderTopLeftRadius: 6 }),
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text
              style={[
                styles.text,
                isUser
                  ? { color: colors.textOnAccent }
                  : { color: customColors.bubbleAiText || colors.text },
              ]}
            >
              {para.trim()}
            </Text>
          </View>
        </Pressable>
      ))}
    </>
  );

  return bubbleContent;
}

/** 流式输出气泡（AI 正在打字） */
export function StreamingBubble({ text }: { text: string }) {
  const colors = useTheme();
  return (
    <View style={[streamStyles.row, streamStyles.rowLeft]}>
      <View style={[streamStyles.bubble, { backgroundColor: colors.bubbleAi, borderWidth: 1, borderColor: colors.border }]}>
        <Text style={[streamStyles.text, { color: colors.text }]}>{text}▌</Text>
      </View>
    </View>
  );
}

const streamStyles = StyleSheet.create({
  row: { marginVertical: 2, paddingHorizontal: 16 },
  rowLeft: { alignItems: "flex-start" },
  bubble: { maxWidth: "84%", paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18 },
  text: { fontSize: 15, lineHeight: 21 },
});

const styles = StyleSheet.create({
  // 系统提示（游戏开始/结束等，不参与交互）
  systemRow: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignItems: "center",
  },
  systemText: {
    fontSize: 12,
    textAlign: "center",
  },
  row: {
    marginVertical: 2,
    paddingHorizontal: 16,
  },
  rowLeft: {
    alignItems: "flex-start",
  },
  rowRight: {
    alignItems: "flex-end",
  },
  bubble: {
    maxWidth: "84%",
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 18,
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
  },
  // 思考过程样式
  thinkingRow: {
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  thinkingToggle: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
  },
  thinkingToggleText: {
    fontSize: 12,
  },
  thinkingBubble: {
    marginTop: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    maxWidth: "85%",
  },
  thinkingText: {
    fontSize: 13,
    lineHeight: 19,
  },
});
