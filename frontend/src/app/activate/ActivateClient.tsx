"use client";

/**
 * [INPUT]: dynamic-imported ActivatePage client component
 * [OUTPUT]: thin client wrapper for the /activate route so the server page can
 *   declare `dynamic = "force-dynamic"`
 * [POS]: dashboard /activate client shell
 * [PROTOCOL]: update header on changes
 */

import dynamic from "next/dynamic";

const ActivatePage = dynamic(
  () => import("@/components/daemon/ActivatePage"),
  { ssr: false },
);

export default function ActivateClient() {
  return <ActivatePage />;
}
