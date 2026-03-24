"use client";

import dynamic from "next/dynamic";

const AdminWaitlistPage = dynamic(() => import("@/components/admin/AdminWaitlistPage"), { ssr: false });

export default function WaitlistPage() {
  return <AdminWaitlistPage />;
}
