"use client";

/**
 * [INPUT]: dynamic-imported DaemonsSettingsPage client component
 * [OUTPUT]: thin client wrapper used by the server page so we can declare
 *   `dynamic = "force-dynamic"` at the page boundary
 * [POS]: dashboard /settings/daemons client shell
 * [PROTOCOL]: update header on changes
 */

import dynamic from "next/dynamic";

const DaemonsSettingsPage = dynamic(
  () => import("@/components/daemon/DaemonsSettingsPage"),
  { ssr: false },
);

export default function DaemonsSettingsClient() {
  return <DaemonsSettingsPage />;
}
