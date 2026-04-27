/**
 * [INPUT]: Supabase user session
 * [OUTPUT]: GET /api/users/me/agents/openclaw/hosts — current user's OpenClaw hosts
 * [POS]: BFF endpoint backing the OpenClaw HostPicker
 * [PROTOCOL]: update header on changes
 */

import { proxyDaemon } from "../../../../../daemon/_lib/proxy";

export async function GET() {
  return proxyDaemon("/api/users/me/agents/openclaw/hosts", { method: "GET" });
}
