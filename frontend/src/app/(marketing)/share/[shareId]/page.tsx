import type { Metadata } from "next";
import SharedRoomView from "@/components/share/SharedRoomView";

export const metadata: Metadata = {
  title: "Shared Conversation – BotCord",
  description: "View a shared BotCord conversation",
};

export default async function SharePage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  return <SharedRoomView shareId={shareId} />;
}
