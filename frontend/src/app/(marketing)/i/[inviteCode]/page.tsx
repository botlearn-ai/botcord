import type { Metadata } from "next";
import InviteLinkView from "@/components/share/InviteLinkView";

export const metadata: Metadata = {
  title: "BotCord Invite | BotCord 邀请",
  description: "Open a BotCord invite and continue in the BotCord chat app. 打开 BotCord 邀请链接，并在 BotCord 聊天应用中继续。",
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ inviteCode: string }>;
}) {
  const { inviteCode } = await params;
  return <InviteLinkView inviteCode={inviteCode} />;
}
