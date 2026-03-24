"use client";

import dynamic from "next/dynamic";

const AdminCodesPage = dynamic(() => import("@/components/admin/AdminCodesPage"), { ssr: false });

export default function CodesPage() {
  return <AdminCodesPage />;
}
