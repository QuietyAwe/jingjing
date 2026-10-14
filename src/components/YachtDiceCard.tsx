// ============================================================
// 快艇骰子面板：显示 5 个骰子，点击可锁定/解锁
// ============================================================

import { useEffect, useState } from "react";
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
  /** 掷骰动画进行中：未锁定的骰子快速滚动，用来填充 LLM 决策的等待 */
  rolling?: boolean;
  /** 对方的名字（如「静静」），用于「XX 的回合」提示 */
  aiName?: string;
}

const DIE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const ROLL_INTERVAL_MS = 110;

export function YachtDiceCard({
  dice,
  kept,
  rollsLeft,
  canRoll,
  onToggle,
  onRoll,
  onScore,
  readOnly,
  rolling,
  aiName = "对方",
}: Props) {
  const colors = useTheme();
  const [rollFaces, setRollFaces] = useState<number[] | null>(null);

  // 掷骰动画：未锁定的骰子每 110ms 换一次点数，锁定的保持不动
  useEffect(() => {
    if (!rolling) {
      setRollFaces(null);
      return;
    }
    const rand = () => Array.from({ length: 5 }, () => 1 + Math.floor(Math.random() * 6));
    setRollFaces(rand());
    const timer = setInterval(() => setRollFaces(rand()), ROLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [rolling]);

  const displayDice = rolling && rollFaces ? dice.map((d, i) => (kept[i] ? d : rollFaces[i])) : dice;

  return (
    <View style={[styles.container, { borderColor: colors.border, backgroundColor: colors.sectionBg }]}>
      <View style={styles.diceRow}>
        {displayDice.map((d, i) => (
          <TouchableOpacity
            key={i}
            onPress={() => !readOnly && !rolling && onToggle(i)}
            disabled={readOnly || rolling}
            style={[
              styles.die,
              {
                backgroundColor: kept[i] ? colors.accent : colors.inputBg,
                borderColor: kept[i] ? colors.accent : colors.border,
                opacity: rolling && !kept[i] ? 0.75 : 1,
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
        {rolling
          ? "🎲 骰子滚动中..."
          : readOnly
          ? `${aiName}的回合`
          : canRoll
          ? `还能掷 ${rollsLeft} 次 · 点骰子可锁定`
          : "选好要填的项"}
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
