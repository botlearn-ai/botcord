import { Link } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { useRealtime } from "@/lib/human";
import { colors } from "@/lib/theme";
import type { DashboardRoom } from "@/lib/types";

export default function Rooms() {
  const [rooms, setRooms] = useState<DashboardRoom[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const overview = await api.getOverview();
      const sorted = [...overview.rooms].sort((a, b) =>
        (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
      );
      setRooms(sorted);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(() => {
    void load();
  });

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <FlatList
      data={rooms}
      keyExtractor={(room) => room.room_id}
      ListEmptyComponent={
        <Text style={styles.empty}>{error ?? (refreshing ? "" : "No conversations yet")}</Text>
      }
      refreshControl={<RefreshControl onRefresh={refresh} refreshing={refreshing} tintColor={colors.accent} />}
      renderItem={({ item }) => (
        <Link asChild href={{ pathname: "/rooms/[roomId]", params: { roomId: item.room_id, name: item.name } }}>
          <Pressable style={styles.row}>
            <View style={styles.rowTop}>
              <Text numberOfLines={1} style={styles.name}>
                {item.name}
              </Text>
              <Text style={styles.time}>{formatTime(item.last_message_at)}</Text>
            </View>
            <View style={styles.rowTop}>
              <Text numberOfLines={1} style={styles.preview}>
                {item.last_sender_name ? `${item.last_sender_name}: ` : ""}
                {item.last_message_preview ?? ""}
              </Text>
              {item.has_unread ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{item.unread_count || ""}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        </Link>
      )}
      style={{ backgroundColor: colors.bg }}
    />
  );
}

const styles = StyleSheet.create({
  row: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth, gap: 4, padding: 16 },
  rowTop: { alignItems: "center", flexDirection: "row", gap: 8, justifyContent: "space-between" },
  name: { color: colors.text, flex: 1, fontSize: 16, fontWeight: "600" },
  time: { color: colors.muted, fontSize: 12 },
  preview: { color: colors.muted, flex: 1, fontSize: 14 },
  badge: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 9,
    height: 18,
    justifyContent: "center",
    minWidth: 18,
    paddingHorizontal: 5,
  },
  badgeText: { color: colors.bg, fontSize: 11, fontWeight: "700" },
  empty: { color: colors.muted, padding: 32, textAlign: "center" },
});
