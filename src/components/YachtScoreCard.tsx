// ============================================================
// 快艇骰子计分卡：13 项，可点击填分
// ============================================================

import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "@/theme/useTheme";
import type { YachtSlot } from "@/game/yacht/rules";

interface ScoreRow {
  slot: YachtSlot;
  label: string;
  section: "upper" | "lower";
  user: number | null;
  ai: number | null;
}

interface Props {
  rows: ScoreRow[];
  /** 轮到用户填分时可点击 */
  selectable?: boolean;
  onSelect?: (slot: YachtSlot) => void;
  /** 对方的名字（如「静静」），默认 "对方" */
  aiName?: string;
  /** 当前骰子在各项的预计得分（selectable 时展示，方便决定填哪项） */
  preview?: Partial<Record<YachtSlot, number>>;
  /** 上半区小计与奖励 */
  upperUser: number;
  bonusUser: number;
  upperAi: number;
  bonusAi: number;
  totalUser: number;
  totalAi: number;
}

export function YachtScoreCard({
  rows,
  selectable,
  onSelect,
  aiName = "对方",
  preview,
  upperUser,
  bonusUser,
  upperAi,
  bonusAi,
  totalUser,
  totalAi,
}: Props) {
  const colors = useTheme();

  return (
    <View style={[styles.container, { borderColor: colors.border, backgroundColor: colors.sectionBg }]}>
      <View style={[styles.headerRow, { borderBottomColor: colors.border }]}>
        <Text style={[styles.headerLabel, { color: colors.textMuted }]}>项目</Text>
        <Text style={[styles.headerCell, { color: colors.textMuted }]}>你</Text>
        <Text style={[styles.headerCell, { color: colors.textMuted }]}>{aiName}</Text>
      </View>

      {rows.map((row) => {
        const isUsed = row.user !== null;
        const enabled = Boolean(selectable && !isUsed);
        const previewValue = preview?.[row.slot];
        return (
          <TouchableOpacity
            key={row.slot}
            disabled={!enabled}
            onPress={() => enabled && onSelect?.(row.slot)}
            style={[
              styles.row,
              {
                borderBottomColor: colors.border,
                backgroundColor: enabled ? colors.accent + "12" : "transparent",
              },
            ]}
          >
            <View style={styles.labelWrap}>
              <Text style={[styles.label, { color: colors.text }]}>{row.label}</Text>
              {previewValue !== undefined && (
                <Text style={[styles.preview, { color: colors.accent }]}>
                  {previewValue > 0 ? `可得 ${previewValue}` : `0 分`}
                </Text>
              )}
            </View>
            <Text style={[styles.cell, { color: row.user !== null ? colors.text : colors.textMuted }]}>
              {row.user ?? "—"}
            </Text>
            <Text style={[styles.cell, { color: row.ai !== null ? colors.text : colors.textMuted }]}>
              {row.ai ?? "—"}
            </Text>
          </TouchableOpacity>
        );
      })}

      <View style={[styles.summary, { borderTopColor: colors.border }]}>
        <Text style={[styles.summaryText, { color: colors.textMuted }]}>
          上半区 {upperUser}{bonusUser > 0 ? ` (+${bonusUser})` : ""} · {upperAi}{bonusAi > 0 ? ` (+${bonusAi})` : ""}
        </Text>
        <Text style={[styles.total, { color: colors.text }]}>
          总分 {totalUser} - {totalAi}
        </Text>
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
  headerRow: {
    flexDirection: "row",
    paddingBottom: 6,
    marginBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLabel: {
    flex: 1,
    fontSize: 11,
  },
  headerCell: {
    width: 48,
    fontSize: 11,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  labelWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  label: {
    fontSize: 13,
  },
  preview: {
    fontSize: 11,
    marginLeft: 6,
  },
  cell: {
    width: 48,
    fontSize: 13,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  summary: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "flex-end",
  },
  summaryText: {
    fontSize: 11,
  },
  total: {
    fontSize: 15,
    fontWeight: "700",
    marginTop: 2,
  },
});
