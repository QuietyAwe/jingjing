// ============================================================
// 聊天气泡：逐段显示、轻柔入场、长按操作
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import type { ChatMessage } from "@/types/schema";
import { useCurrentCustomColors, useTheme } from "@/theme/useTheme";
import type { ColorPalette } from "@/theme/colors";
import { MOTION, useReducedMotion } from "@/utils/motion";
import { splitForChat, revealStepMs } from "@/utils/text";

interface Props {
  message: ChatMessage;
  onLongPress?: () => void;
  /** 新消息入场；多条回复同时沿用原有逐段延迟 */
  shouldAnimate?: boolean;
  /** 每显示一条新气泡时回调（用于自动滚底） */
  onBubbleAppear?: () => void;
}

/** 同一条消息只播一次，列表重挂载和游戏卡展开不重播。 */
const revealedMsgIds = new Set<string>();

interface BubbleParagraphProps {
  para: string;
  index: number;
  count: number;
  isUser: boolean;
  colors: ColorPalette;
  aiTextColor: string;
  animate: boolean;
  reducedMotion: boolean;
  onLongPress?: () => void;
}

function BubbleParagraph({
  para,
  index,
  count,
  isUser,
  colors,
  aiTextColor,
  animate,
  reducedMotion,
  onLongPress,
}: BubbleParagraphProps) {
  const [pressed, setPressed] = useState(false);
  const progress = useRef(new Animated.Value(animate && !reducedMotion ? 0 : 1)).current;

  useEffect(() => {
    if (!animate) return;
    if (reducedMotion) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: MOTION.enterDuration,
      easing: MOTION.easing,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [animate, progress, reducedMotion]);

  return (
    <Animated.View
      style={[
        styles.row,
        isUser ? styles.rowRight : styles.rowLeft,
        index === 0 && styles.rowFirst,
        index === count - 1 && styles.rowLast,
        {
          opacity: progress,
          transform: [{
            translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [MOTION.enterDistance, 0] }),
          }],
        },
      ]}
    >
      <Pressable
        onLongPress={onLongPress}
        onPressIn={onLongPress ? () => setPressed(true) : undefined}
        onPressOut={onLongPress ? () => setPressed(false) : undefined}
        delayLongPress={400}
        accessibilityHint={onLongPress ? "长按可编辑、复制或删除消息" : undefined}
        style={[
          styles.bubble,
          isUser
            ? { backgroundColor: colors.bubbleUser }
            : { backgroundColor: colors.bubbleAi, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
          index < count - 1 && (isUser
            ? { borderBottomRightRadius: 6 }
            : { borderBottomLeftRadius: 6 }),
          index > 0 && (isUser
            ? { borderTopRightRadius: 6 }
            : { borderTopLeftRadius: 6 }),
          pressed && styles.bubblePressed,
        ]}
      >
        <Text style={[styles.text, { color: isUser ? colors.textOnAccent : aiTextColor }]}>
          {para.trim()}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

function ConversationBubble({ message, onLongPress, shouldAnimate, onBubbleAppear }: Props) {
  const isUser = message.role === "user";
  const colors = useTheme();
  const customColors = useCurrentCustomColors();
  const reducedMotion = useReducedMotion();
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const shouldEnter = useRef(!!shouldAnimate && !revealedMsgIds.has(message.id)).current;

  const paragraphs = useMemo(
    () => isUser ? [message.content] : splitForChat(message.content),
    [isUser, message.content]
  );

  // 首帧锁定显示方式，绝不先渲染全文再回退成逐条出现。
  const shouldDelay = !isUser && shouldEnter && paragraphs.length > 1;
  const [visibleCount, setVisibleCount] = useState(shouldDelay ? 1 : paragraphs.length);

  useEffect(() => {
    revealedMsgIds.add(message.id);
    if (!shouldDelay) {
      onBubbleAppear?.();
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    let acc = 0;
    for (let i = 1; i < paragraphs.length; i++) {
      acc += revealStepMs(paragraphs[i - 1]);
      timers.push(setTimeout(() => {
        setVisibleCount(i + 1);
        onBubbleAppear?.();
      }, acc));
    }
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id]);

  return (
    <>
      {!isUser && message.thinking ? (
        <View style={styles.thinkingRow}>
          <Pressable
            style={[styles.thinkingToggle, { backgroundColor: colors.bg, borderColor: colors.border }]}
            onPress={() => setThinkingExpanded((value) => !value)}
            accessibilityRole="button"
            accessibilityState={{ expanded: thinkingExpanded }}
            hitSlop={6}
          >
            <Text style={[styles.thinkingToggleText, { color: colors.textMuted }]}>
              {thinkingExpanded ? "▾ 收起思考" : "▸ 查看思考"}
            </Text>
          </Pressable>
          {thinkingExpanded ? (
            <View style={[styles.thinkingBubble, { backgroundColor: colors.bg, borderColor: colors.border }]}>
              <Text style={[styles.thinkingText, { color: colors.textMuted }]}>{message.thinking}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {paragraphs.slice(0, visibleCount).map((para, index) => (
        <BubbleParagraph
          key={index}
          para={para}
          index={index}
          count={visibleCount}
          isUser={isUser}
          colors={colors}
          aiTextColor={customColors.bubbleAiText || colors.text}
          animate={shouldEnter}
          reducedMotion={reducedMotion}
          onLongPress={onLongPress}
        />
      ))}
    </>
  );
}

export default function ChatBubble(props: Props) {
  if (props.message.role === "system") {
    return <SystemMessage content={props.message.content} />;
  }
  return <ConversationBubble {...props} />;
}

function SystemMessage({ content }: { content: string }) {
  const colors = useTheme();
  return (
    <View style={styles.systemRow}>
      <Text style={[styles.systemText, { color: colors.textMuted }]}>{content}</Text>
    </View>
  );
}

/** 流式输出气泡（AI 正在打字） */
export function StreamingBubble({ text }: { text: string }) {
  const colors = useTheme();
  const customColors = useCurrentCustomColors();
  return (
    <View style={[streamStyles.row, streamStyles.rowLeft]}>
      <View style={[streamStyles.bubble, { backgroundColor: colors.bubbleAi, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }]}>
        <Text style={[streamStyles.text, { color: customColors.bubbleAiText || colors.text }]}>
          {text}<Text style={{ color: colors.accent }}>▌</Text>
        </Text>
      </View>
    </View>
  );
}

const streamStyles = StyleSheet.create({
  row: { marginVertical: 6, paddingHorizontal: 16 },
  rowLeft: { alignItems: "flex-start" },
  bubble: { maxWidth: "82%", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 19 },
  text: { fontSize: 16, lineHeight: 24 },
});

const styles = StyleSheet.create({
  systemRow: {
    paddingHorizontal: 24,
    paddingVertical: 8,
    alignItems: "center",
  },
  systemText: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
  row: {
    marginVertical: 2,
    paddingHorizontal: 16,
  },
  rowFirst: { marginTop: 6 },
  rowLast: { marginBottom: 6 },
  rowLeft: { alignItems: "flex-start" },
  rowRight: { alignItems: "flex-end" },
  bubble: {
    maxWidth: "82%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 19,
  },
  bubblePressed: {
    opacity: 0.88,
    transform: [{ scale: 0.99 }],
  },
  text: {
    fontSize: 16,
    lineHeight: 24,
  },
  thinkingRow: {
    paddingHorizontal: 16,
    marginTop: 6,
    marginBottom: 2,
  },
  thinkingToggle: {
    alignSelf: "flex-start",
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  thinkingToggleText: {
    fontSize: 12,
    lineHeight: 18,
  },
  thinkingBubble: {
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: "85%",
  },
  thinkingText: {
    fontSize: 13,
    lineHeight: 20,
  },
});
