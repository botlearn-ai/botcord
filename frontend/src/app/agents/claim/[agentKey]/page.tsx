"use client";

import { useParams } from "next/navigation";
import ClaimAgentPage from "@/components/claim/ClaimAgentPage";

export default function AgentClaimPageRoute() {
  const params = useParams<{ agentKey: string }>();
  const claimCode = typeof params?.agentKey === "string" ? params.agentKey : "";
  return <ClaimAgentPage claimCode={claimCode} />;
}
