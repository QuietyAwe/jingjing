import { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/theme/useTheme";

interface Props {
  title: string;
  icon?: string;
  defaultExpanded?: boolean;
  right?: React.ReactNode;
  children: React.ReactNode;
}

export function CollapsibleSection({ title, icon, defaultExpanded = true, right, children }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const colors = useTheme();

  return (
    <View style={[styles.section, { backgroundColor: colors.sectionBg, borderColor: colors.border }]}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded((value) => !value)}
        activeOpacity={0.65}
        accessibilityRole="button"
        accessibilityLabel={`${title}分组`}
        accessibilityState={{ expanded }}
      >
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {icon ? `${icon} ` : ""}{title}
        </Text>
        <View style={styles.headerRight}>
          {right}
          <Ionicons
            name={expanded ? "chevron-down" : "chevron-forward"}
            size={15}
            color={colors.textMuted}
          />
        </View>
      </TouchableOpacity>
      {expanded ? <View style={styles.content}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginHorizontal: 12,
    marginBottom: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    paddingHorizontal: 16,
  },
  header: {
    minHeight: 50,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { flexShrink: 1, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  content: { paddingBottom: 8 },
});
