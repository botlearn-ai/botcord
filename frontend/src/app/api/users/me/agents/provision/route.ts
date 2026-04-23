/**
 * [INPUT]: Supabase user session, provision body {daemon_instance_id, label, runtime, cwd?, bio?}
 * [OUTPUT]: POST /api/users/me/agents/provision — forwards to backend /api/users/me/agents/provision
 * [POS]: BFF endpoint backing CreateAgentDialog — creates a user-owned Agent row on the Hub and
 *        ships the Hub-generated credentials to the daemon via the provision_agent control frame.
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyDaemon } from "../../../../daemon/_lib/proxy";

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  return proxyDaemon("/api/users/me/agents/provision", {
    method: "POST",
    body,
  });
}
