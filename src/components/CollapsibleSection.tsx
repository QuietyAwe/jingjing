import { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
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
    <View style={[styles.section, { backgroundColor: colors.sectionBg }]}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.6}
      >
        <Text style={[styles.title, { color: colors.textMuted }]}>
          {icon ? `${icon} ` : ""}{title}
        </Text>
        <View style={styles.headerRight}>
          {right}
          <Text style={[styles.arrow, { color: colors.textMuted }]}>
            {expanded ? "▼" : "▶"}
          </Text>
        </View>
      </TouchableOpacity>
      {expanded && <View style={styles.content}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 16, overflow: "hidden", paddingHorizontal: 20 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1 },
  arrow: { fontSize: 10 },
  content: { paddingBottom: 4 },
});
