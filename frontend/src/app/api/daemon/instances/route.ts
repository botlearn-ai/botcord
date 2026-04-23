/**
 * [INPUT]: Supabase user session
 * [OUTPUT]: GET /api/daemon/instances — list current user's daemon_instances
 * [POS]: BFF endpoint for /settings/daemons listing
 * [PROTOCOL]: update header on changes
 */

import { proxyDaemon } from "../_lib/proxy";

export async function GET() {
  return proxyDaemon("/daemon/instances", { method: "GET" });
}
