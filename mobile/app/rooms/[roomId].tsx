import { Stack, useLocalSearchParams } from "expo-router";
import { ChatView } from "@/components/ChatView";

export default function Room() {
  const { roomId, name } = useLocalSearchParams<{ roomId: string; name?: string }>();
  return (
    <>
      <Stack.Screen options={{ title: name ?? "" }} />
      <ChatView roomId={roomId} />
    </>
  );
}
