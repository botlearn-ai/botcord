"use client";

import dynamic from "next/dynamic";

const InvitePage = dynamic(() => import("@/components/invite/InvitePage"), { ssr: false });

export default function Invite() {
  return <InvitePage />;
}
