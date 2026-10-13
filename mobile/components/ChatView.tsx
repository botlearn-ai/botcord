import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, resolveFileUrl } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { useRealtime } from "@/lib/human";
import { colors } from "@/lib/theme";
import type { Attachment, DashboardMessage } from "@/lib/types";

// After sending to an owned agent, poll for its reply in case the realtime
// hint for the owner-chat room is missed.
const REPLY_POLL_MS = 3000;
const REPLY_POLL_MAX_MS = 120_000;

type Props = {
  roomId: string;
  /** Set for owner ↔ agent chat: sends go through /api/dashboard/chat/send. */
  agentId?: string;
};

export function ChatView({ roomId, agentId }: Props) {
  const insets = useSafeAreaInsets();
  // Newest first, rendered by an inverted FlatList.
  const [messages, setMessages] = useState<DashboardMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const loadingOlderRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch the latest page and merge it over what we have, keeping older pages.
  const loadLatest = useCallback(async () => {
    try {
      const res = await api.getRoomMessages(roomId);
      setMessages((prev) => {
        if (prev.length === 0) {
          setHasMore(res.has_more);
          return res.messages;
        }
        const fresh = new Set(res.messages.map((m) => m.hub_msg_id));
        const oldestFresh = res.messages.at(-1)?.created_at ?? "";
        return [...res.messages, ...prev.filter((m) => !fresh.has(m.hub_msg_id) && m.created_at < oldestFresh)];
      });
      setError(null);
      void api.markRoomRead(roomId).catch(() => undefined);
      return res.messages;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => {
    void loadLatest();
    return stopPolling;
  }, [loadLatest, stopPolling]);

  useRealtime((event) => {
    if (event.room_id === roomId) void loadLatest();
  });

  function pollForReply(sentAt: string) {
    stopPolling();
    const started = Date.now();
    pollRef.current = setInterval(async () => {
      const latest = await loadLatest();
      const replied = latest?.some((m) => !m.is_mine && m.created_at > sentAt);
      if (replied || Date.now() - started > REPLY_POLL_MAX_MS) stopPolling();
    }, REPLY_POLL_MS);
  }

  async function loadOlder() {
    const oldest = messages.at(-1);
    if (!hasMore || !oldest || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const res = await api.getRoomMessages(roomId, { before: oldest.hub_msg_id });
      setMessages((prev) => [...prev, ...res.messages]);
      setHasMore(res.has_more);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }

  async function pickImage() {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    if (result.canceled) return;
    const asset = result.assets[0];
    const name = asset.fileName ?? `image-${Date.now()}.jpg`;
    const type = asset.mimeType ?? "image/jpeg";
    setBusy(true);
    try {
      const uploaded = await api.uploadFile(asset.file ?? { uri: asset.uri, name, type }, agentId);
      setPending((prev) => [
        ...prev,
        {
          filename: uploaded.original_filename,
          url: uploaded.url,
          content_type: uploaded.content_type,
          size_bytes: uploaded.size_bytes,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const text = draft.trim();
    if ((!text && pending.length === 0) || busy) return;
    setBusy(true);
    const sentAt = new Date().toISOString();
    try {
      if (agentId) {
        await api.sendOwnerChatMessage(agentId, text, pending);
      } else {
        await api.sendRoomMessage(roomId, text, pending);
      }
      setDraft("");
      setPending([]);
      await loadLatest();
      if (agentId) pollForReply(sentAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}
      style={styles.container}
    >
      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ flex: 1 }} />
      ) : (
        <FlatList
          contentContainerStyle={{ gap: 8, padding: 12 }}
          data={messages}
          inverted
          keyExtractor={(m) => m.hub_msg_id}
          ListFooterComponent={loadingOlder ? <ActivityIndicator color={colors.muted} /> : null}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.3}
          renderItem={({ item }) => <Bubble message={item} />}
        />
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {pending.length > 0 ? (
        <View style={styles.pending}>
          {pending.map((att, i) => (
            <Pressable accessibilityRole="button" key={att.url} onPress={() => setPending((prev) => prev.filter((_, j) => j !== i))}>
              <Image source={{ uri: resolveFileUrl(att.url) }} style={styles.pendingThumb} />
              <Text style={styles.pendingRemove}>×</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={pickImage} style={styles.attach}>
          <Text style={styles.attachText}>＋</Text>
        </Pressable>
        <TextInput
          multiline
          onChangeText={setDraft}
          placeholder="Message"
          placeholderTextColor={colors.muted}
          style={styles.input}
          value={draft}
        />
        <Pressable accessibilityRole="button" disabled={(!draft.trim() && pending.length === 0) || busy} onPress={send} style={styles.send}>
          {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.sendText}>Send</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ message }: { message: DashboardMessage }) {
  const mine = Boolean(message.is_mine);
  const attachments = message.is_recalled ? [] : (message.payload?.attachments ?? []);
  return (
    <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
      {mine ? null : (
        <Text style={styles.sender}>{message.display_sender_name ?? message.sender_name}</Text>
      )}
      {message.is_recalled ? (
        <Text style={[styles.text, { color: colors.muted, fontStyle: "italic" }]}>Message recalled</Text>
      ) : message.text ? (
        <Text selectable style={styles.text}>
          {message.text}
        </Text>
      ) : null}
      {attachments.map((att, i) => {
        const url = resolveFileUrl(att.url);
        return att.content_type?.startsWith("image/") ? (
          <Pressable accessibilityRole="button" key={`${att.url}-${i}`} onPress={() => void Linking.openURL(url)}>
            <Image contentFit="cover" source={{ uri: url }} style={styles.image} />
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" key={`${att.url}-${i}`} onPress={() => void Linking.openURL(url)}>
            <Text style={styles.file}>📎 {att.filename}</Text>
          </Pressable>
        );
      })}
      <Text style={styles.time}>{formatTime(message.created_at)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  bubble: { borderRadius: 12, gap: 4, maxWidth: "85%", padding: 10 },
  bubbleMine: { alignSelf: "flex-end", backgroundColor: colors.mine },
  bubbleOther: { alignSelf: "flex-start", backgroundColor: colors.surface },
  sender: { color: colors.accent, fontSize: 12, fontWeight: "600" },
  text: { color: colors.text, fontSize: 15, lineHeight: 21 },
  image: { borderRadius: 8, height: 180, width: 220 },
  file: { color: colors.accent, fontSize: 14, textDecorationLine: "underline" },
  time: { alignSelf: "flex-end", color: colors.muted, fontSize: 10 },
  error: { color: colors.danger, paddingHorizontal: 12, paddingVertical: 4 },
  pending: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 12, paddingTop: 8 },
  pendingThumb: { borderRadius: 6, height: 56, width: 56 },
  pendingRemove: {
    backgroundColor: colors.bg,
    borderRadius: 9,
    color: colors.text,
    height: 18,
    position: "absolute",
    right: -6,
    textAlign: "center",
    top: -6,
    width: 18,
  },
  composer: {
    alignItems: "flex-end",
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  attach: { alignItems: "center", height: 36, justifyContent: "center", width: 28 },
  attachText: { color: colors.muted, fontSize: 24 },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    color: colors.text,
    flex: 1,
    fontSize: 15,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  send: { backgroundColor: colors.accent, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 9 },
  sendText: { color: colors.bg, fontWeight: "600" },
});
