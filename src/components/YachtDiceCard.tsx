// ============================================================
// 快艇骰子面板：显示 5 个骰子，点击可锁定/解锁
// ============================================================

import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "@/theme/useTheme";

interface Props {
  dice: number[];
  kept: boolean[];
  rollsLeft: number;
  canRoll: boolean;
  onToggle: (index: number) => void;
  onRoll: () => void;
  onScore: () => void;
  /** 只读展示（AI 回合） */
  readOnly?: boolean;
}

const DIE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

export function YachtDiceCard({
  dice,
  kept,
  rollsLeft,
  canRoll,
  onToggle,
  onRoll,
  onScore,
  readOnly,
}: Props) {
  const colors = useTheme();

  return (
    <View style={[styles.container, { borderColor: colors.border, backgroundColor: colors.sectionBg }]}>
      <View style={styles.diceRow}>
        {dice.map((d, i) => (
          <TouchableOpacity
            key={i}
            onPress={() => !readOnly && onToggle(i)}
            disabled={readOnly}
            style={[
              styles.die,
              {
                backgroundColor: kept[i] ? colors.accent : colors.inputBg,
                borderColor: kept[i] ? colors.accent : colors.border,
              },
            ]}
          >
            <Text
              style={[
                styles.dieText,
                { color: kept[i] ? colors.textOnAccent : colors.text },
              ]}
            >
              {DIE_FACES[d - 1] ?? String(d)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={[styles.hint, { color: colors.textMuted }]}>
        {readOnly ? "AI 的回合" : canRoll ? `还能掷 ${rollsLeft} 次 · 点骰子可锁定` : "选好要填的项"}
      </Text>

      {!readOnly && (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.btn, { borderColor: colors.border, opacity: canRoll ? 1 : 0.4 }]}
            onPress={onRoll}
            disabled={!canRoll}
          >
            <Text style={[styles.btnText, { color: colors.text }]}>🎲 重掷</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: colors.accent }]}
            onPress={onScore}
          >
            <Text style={[styles.btnText, { color: colors.textOnAccent }]}>✅ 填分</Text>
          </TouchableOpacity>
        </View>
      )}
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
  helpBtn: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  helpText: {
    fontSize: 12,
    fontWeight: "600",
  },
  diceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  die: {
    width: 48,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dieText: {
    fontSize: 26,
    lineHeight: 30,
  },
  hint: {
    fontSize: 11,
    marginTop: 8,
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
    gap: 10,
  },
  btn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
  },
  btnText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
