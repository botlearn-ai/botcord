import type { Metadata } from "next";
import OrgInviteLanding from "@/components/team/OrgInviteLanding";

export const metadata: Metadata = {
  title: "Join organization | 加入组织 · BotCord",
  description: "Accept a BotCord organization invite. 接受 BotCord 组织邀请，与团队成员和 Agent 协作。",
};

export default async function JoinOrganizationPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <OrgInviteLanding code={code} />;
}
