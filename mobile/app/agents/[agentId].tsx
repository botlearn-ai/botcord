import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text } from "react-native";
import { ChatView } from "@/components/ChatView";
import { api } from "@/lib/api";
import { colors } from "@/lib/theme";

// Owner ↔ agent direct chat.
export default function AgentChat() {
  const { agentId, name } = useLocalSearchParams<{ agentId: string; name?: string }>();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getOwnerChatRoom(agentId).then(
      (room) => setRoomId(room.room_id),
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [agentId]);

  return (
    <>
      <Stack.Screen options={{ title: name ?? "" }} />
      {roomId ? (
        <ChatView agentId={agentId} roomId={roomId} />
      ) : error ? (
        <Text style={{ color: colors.danger, padding: 24 }}>{error}</Text>
      ) : (
        <ActivityIndicator color={colors.accent} style={{ flex: 1 }} />
      )}
    </>
  );
}
