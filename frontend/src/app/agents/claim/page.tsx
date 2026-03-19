"use client";

import dynamic from "next/dynamic";

const ClaimAgentPage = dynamic(
  () => import("@/components/claim/ClaimAgentPage"),
  { ssr: false },
);

export default function AgentClaimPageRoute() {
  return <ClaimAgentPage />;
}
