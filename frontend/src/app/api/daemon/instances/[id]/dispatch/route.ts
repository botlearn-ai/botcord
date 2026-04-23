/**
 * [INPUT]: Supabase user session, daemon instance id from path, control-frame body
 * [OUTPUT]: POST /api/daemon/instances/[id]/dispatch — forwards to backend /daemon/instances/{id}/dispatch
 * [POS]: BFF endpoint backing CreateAgentDialog (provision_agent) and future dashboard control flows
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyDaemon } from "../../../_lib/proxy";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  return proxyDaemon(
    `/daemon/instances/${encodeURIComponent(id)}/dispatch`,
    { method: "POST", body },
  );
}
