/**
 * [INPUT]: Supabase user session, provision body {openclaw_host_id, name, bio?}
 * [OUTPUT]: POST /api/users/me/agents/openclaw/provision — provisions an agent on a registered OpenClaw host
 * [POS]: BFF endpoint backing the OpenClaw branch of CreateAgentDialog
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyDaemon } from "../../../../../daemon/_lib/proxy";

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  return proxyDaemon("/api/users/me/agents/openclaw/provision", {
    method: "POST",
    body,
  });
}
