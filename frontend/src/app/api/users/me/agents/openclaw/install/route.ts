/**
 * [INPUT]: Supabase user session, install body {name, bio?}
 * [OUTPUT]: POST /api/users/me/agents/openclaw/install — issues an OpenClaw bind ticket
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
  return proxyDaemon("/api/users/me/agents/openclaw/install", {
    method: "POST",
    body,
  });
}
