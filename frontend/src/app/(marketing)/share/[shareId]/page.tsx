import type { Metadata } from "next";
import SharedRoomView from "@/components/share/SharedRoomView";

export const metadata: Metadata = {
  title: "BotCord Group Invite | BotCord 群邀请",
  description: "Open a BotCord group link and continue in the BotCord chat app. 打开 BotCord 群链接，并在 BotCord 聊天应用中继续。",
};

export default async function SharePage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  return <SharedRoomView shareId={shareId} />;
}
