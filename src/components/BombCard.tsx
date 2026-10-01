// ============================================================
// 数字炸弹面板：显示当前范围、轮到谁、已猜历史
// ============================================================

import { View, Text, StyleSheet } from "react-native";
import { useTheme } from "@/theme/useTheme";
import type { BombState } from "@/game/bomb/engine";
import { currentRange } from "@/game/bomb/engine";

interface Props {
  state: BombState;
  aiName?: string;
  onQuit?: () => void;
}

export function BombCard({ state, aiName = "AI", onQuit }: Props) {
  const colors = useTheme();
  const { low, high } = currentRange(state);

  return (
    <View style={[styles.container, { borderColor: colors.border, backgroundColor: colors.sectionBg }]}>
      <Text style={[styles.title, { color: colors.text }]}>
        💣 数字炸弹 · {state.finished ? "已结束" : state.currentPlayer === "user" ? "轮到你猜" : `轮到${aiName}猜`}
      </Text>

      <Text style={[styles.range, { color: colors.accent }]}>
        当前范围：{low} ~ {high}
      </Text>

      {state.guesses.length > 0 && (
        <View style={styles.historyWrap}>
          {state.guesses.slice(-6).map((g, i) => (
            <Text key={i} style={[styles.historyItem, { color: colors.textMuted }]}>
              {g.player === "user" ? "你" : aiName}猜 {g.value}
              {g.result === "high" ? "（大了）" : g.result === "low" ? "（小了）" : "（💥 炸弹）"}
            </Text>
          ))}
        </View>
      )}

      <Text style={[styles.hint, { color: colors.textMuted }]}>
        {state.currentPlayer === "user" && !state.finished
          ? "在聊天框输入 1-100 的数字来猜"
          : "在聊天框可以继续闲聊"}
      </Text>

      {onQuit && !state.finished ? (
        <Text style={[styles.quitText, { color: colors.textMuted }]} onPress={onQuit}>
          退出对局
        </Text>
      ) : null}
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
  range: {
    fontSize: 18,
    fontWeight: "700",
    marginTop: 8,
  },
  historyWrap: {
    marginTop: 8,
  },
  historyItem: {
    fontSize: 11,
    paddingVertical: 2,
  },
  hint: {
    fontSize: 11,
    marginTop: 8,
    textAlign: "center",
  },
  quitText: {
    fontSize: 12,
    marginTop: 8,
    textAlign: "center",
    textDecorationLine: "underline",
  },
});
