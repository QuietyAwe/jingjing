// ============================================================
// 真心话大冒险面板：单骰 + 6 题题库 + 掷骰按钮
// ============================================================

import { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "@/theme/useTheme";
import type { TruthDareState } from "@/game/truthDare/engine";
import { pendingQuestion, remainingCount, isUserTurn } from "@/game/truthDare/engine";
import { KIND_LABEL } from "@/game/truthDare/prompt";

interface Props {
  state: TruthDareState;
  aiName?: string;
  /** 掷骰动画进行中 */
  rolling?: boolean;
  /** 掷出的真实点数（动画结束后定格显示，与抽中的题号一致） */
  realFace?: number;
  /** 用户可掷骰（自己的回合且未在作答） */
  canRoll: boolean;
  onRoll: () => void;
  onEditBank: () => void;
  onQuit?: () => void;
  /** 操作禁用（AI 回合/发言中），防止编辑/退出竞态 */
  disabled?: boolean;
}

export function TruthDareCard({
  state,
  aiName = "对方",
  rolling,
  realFace,
  canRoll,
  onRoll,
  onEditBank,
  onQuit,
  disabled,
}: Props) {
  const colors = useTheme();
  const pending = pendingQuestion(state);
  const [animFace, setAnimFace] = useState(1);

  // 掷骰动画：点数 1~6 快速滚动
  useEffect(() => {
    if (!rolling) return;
    const timer = setInterval(
      () => setAnimFace(1 + Math.floor(Math.random() * 6)),
      110
    );
    return () => clearInterval(timer);
  }, [rolling]);

  // 定格在真实点数，保证骰面与「掷出 N」一致
  const dieFace = rolling ? animFace : realFace ?? 1;

  const turnText = state.finished
    ? "已结束"
    : pending
    ? pending.answeredBy === "user"
      ? "轮到你回答"
      : `轮到${aiName}回答`
    : isUserTurn(state)
    ? "轮到你掷骰"
    : `轮到${aiName}掷骰`;

  return (
    <View style={[styles.container, { borderColor: colors.border, backgroundColor: colors.sectionBg }]}>
      <Text style={[styles.title, { color: colors.text }]}>
        ❤️ 真心话大冒险 · {turnText}
      </Text>

      {/* 单骰 */}
      <View style={styles.diceRow}>
        <View
          style={[
            styles.die,
            {
              backgroundColor: rolling ? colors.accent : colors.inputBg,
              borderColor: rolling ? colors.accent : colors.border,
            },
          ]}
        >
          <Text
            style={[
              styles.dieText,
              { color: rolling ? colors.textOnAccent : colors.text },
            ]}
          >
            {["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][dieFace - 1]}
          </Text>
        </View>
        <Text style={[styles.remain, { color: colors.textMuted }]}>
          第 {state.round} 批 · 剩 {remainingCount(state)} 题
        </Text>
      </View>

      {/* 当前抽中的题 */}
      {pending && (
        <View style={[styles.pendingBox, { borderColor: colors.accent }]}>
          <Text style={[styles.pendingTag, { color: colors.accent }]}>
            {pending.index} 号 · {KIND_LABEL[pending.kind]}
          </Text>
          <Text style={[styles.pendingText, { color: colors.text }]}>{pending.text}</Text>
        </View>
      )}

      {/* 题库 6 格 */}
      <View style={styles.bankWrap}>
        {state.questions.map((q) => (
          <View
            key={q.index}
            style={[
              styles.bankCell,
              {
                borderColor: q.used ? colors.border : colors.accent,
                opacity: q.used ? 0.4 : 1,
                backgroundColor: q.index === state.pendingIndex ? colors.accent : "transparent",
              },
            ]}
          >
            <Text
              style={[
                styles.bankIndex,
                { color: q.index === state.pendingIndex ? colors.textOnAccent : colors.textMuted },
              ]}
            >
              {q.index} · {q.kind === "truth" ? "❤️" : "🔥"}
            </Text>
            <Text
              style={[
                styles.bankText,
                { color: q.index === state.pendingIndex ? colors.textOnAccent : colors.text },
              ]}
              numberOfLines={2}
            >
              {q.text}
            </Text>
          </View>
        ))}
      </View>

      {/* 操作 */}
      {canRoll && !state.finished && (
        <TouchableOpacity
          style={[styles.rollBtn, { backgroundColor: colors.accent, opacity: rolling ? 0.5 : 1 }]}
          onPress={onRoll}
          disabled={rolling}
        >
          <Text style={[styles.rollBtnText, { color: colors.textOnAccent }]}>
            {rolling ? "🎲 掷骰中..." : "🎲 掷骰子"}
          </Text>
        </TouchableOpacity>
      )}

      <View style={styles.footerRow}>
        <Text
          style={[styles.linkText, { color: colors.textMuted }, disabled && { opacity: 0.4 }]}
          onPress={() => !disabled && onEditBank()}
        >
          编辑题库
        </Text>
        {onQuit && !state.finished ? (
          <Text
            style={[styles.linkText, { color: colors.textMuted }, disabled && { opacity: 0.4 }]}
            onPress={() => !disabled && onQuit()}
          >
            退出对局
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginVertical: 6,
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
  },
  diceRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    gap: 12,
  },
  die: {
    width: 52,
    height: 52,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dieText: {
    fontSize: 30,
    lineHeight: 34,
  },
  remain: {
    fontSize: 12,
  },
  pendingBox: {
    marginTop: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  pendingTag: {
    fontSize: 11,
    fontWeight: "700",
  },
  pendingText: {
    fontSize: 15,
    marginTop: 4,
    lineHeight: 21,
    fontWeight: "600",
  },
  bankWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 10,
  },
  bankCell: {
    width: "31.5%",
    minHeight: 52,
    padding: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  bankIndex: {
    fontSize: 9,
    fontWeight: "700",
  },
  bankText: {
    fontSize: 10,
    lineHeight: 13,
    marginTop: 2,
  },
  rollBtn: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  rollBtnText: {
    fontSize: 15,
    fontWeight: "700",
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
  },
  linkText: {
    fontSize: 12,
    textDecorationLine: "underline",
  },
});
