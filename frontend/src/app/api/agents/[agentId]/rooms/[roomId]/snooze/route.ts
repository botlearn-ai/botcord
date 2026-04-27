/**
 * [INPUT]: agentId + roomId from path; POST body { minutes: 0..43200 }
 * [OUTPUT]: POST /api/agents/[agentId]/rooms/[roomId]/snooze — proxies to Hub
 * [POS]: BFF endpoint for quick-snooze buttons in the per-room policy card
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyHub } from "../../../../../_lib/proxy-hub";

type Params = { params: Promise<{ agentId: string; roomId: string }> };

export async function POST(req: Request, { params }: Params) {
  const { agentId, roomId } = await params;
  if (!agentId || !roomId) {
    return NextResponse.json({ error: "missing_param" }, { status: 400 });
  }
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return proxyHub(
    `/api/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(roomId)}/snooze`,
    { method: "POST", body },
  );
}
