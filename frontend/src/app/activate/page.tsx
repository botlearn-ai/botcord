/**
 * [INPUT]: ActivateClient client wrapper
 * [OUTPUT]: /activate page — daemon device-code authorization (plan §6.1)
 * [POS]: top-level App Router page; component lives in components/daemon/ActivatePage
 * [PROTOCOL]: update header on changes
 */

import ActivateClient from "./ActivateClient";

// Activation depends on the user's Supabase session at runtime; skip static
// prerender to avoid touching the Supabase client during the build.
export const dynamic = "force-dynamic";

export default function Page() {
  return <ActivateClient />;
}
