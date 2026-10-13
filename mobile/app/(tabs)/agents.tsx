import { Link } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { api } from "@/lib/api";
import { colors } from "@/lib/theme";
import type { UserAgent } from "@/lib/types";

export default function Agents() {
  const [agents, setAgents] = useState<UserAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.getMyAgents();
      setAgents(res.agents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <FlatList
      data={agents}
      keyExtractor={(agent) => agent.agent_id}
      ListEmptyComponent={
        <Text style={styles.empty}>{error ?? (refreshing ? "" : "No agents yet. Create one on botcord.chat.")}</Text>
      }
      refreshControl={<RefreshControl onRefresh={refresh} refreshing={refreshing} tintColor={colors.accent} />}
      renderItem={({ item }) => (
        <Link
          asChild
          href={{ pathname: "/agents/[agentId]", params: { agentId: item.agent_id, name: item.display_name } }}
        >
          <Pressable style={styles.row}>
            <View style={[styles.dot, { backgroundColor: item.ws_online ? "#4ade80" : colors.border }]} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text numberOfLines={1} style={styles.name}>
                {item.display_name}
              </Text>
              <Text numberOfLines={1} style={styles.meta}>
                {[item.runtime, item.agent_id].filter(Boolean).join(" · ")}
              </Text>
            </View>
          </Pressable>
        </Link>
      )}
      style={{ backgroundColor: colors.bg }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    padding: 16,
  },
  dot: { borderRadius: 5, height: 10, width: 10 },
  name: { color: colors.text, fontSize: 16, fontWeight: "600" },
  meta: { color: colors.muted, fontSize: 12 },
  empty: { color: colors.muted, padding: 32, textAlign: "center" },
});
