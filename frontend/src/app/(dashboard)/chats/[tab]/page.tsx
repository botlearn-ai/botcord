"use client";

import dynamic from "next/dynamic";

const DashboardApp = dynamic(
  () => import("@/components/dashboard/DashboardApp"),
  { ssr: false },
);

export default function ChatsTabPage() {
  return <DashboardApp />;
}
