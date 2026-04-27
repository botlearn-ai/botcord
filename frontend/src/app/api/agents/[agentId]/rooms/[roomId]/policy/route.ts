/**
 * [INPUT]: agentId + roomId from path; PUT body is a partial RoomPolicyOverride
 * [OUTPUT]: GET/PUT/DELETE /api/agents/[agentId]/rooms/[roomId]/policy — proxies to Hub
 * [POS]: BFF endpoints for the per-room attention override card
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyHub } from "../../../../../_lib/proxy-hub";

type Params = { params: Promise<{ agentId: string; roomId: string }> };

function path(agentId: string, roomId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(roomId)}/policy`;
}

export async function GET(_req: Request, { params }: Params) {
  const { agentId, roomId } = await params;
  if (!agentId || !roomId) {
    return NextResponse.json({ error: "missing_param" }, { status: 400 });
  }
  return proxyHub(path(agentId, roomId), { method: "GET" });
}

export async function PUT(req: Request, { params }: Params) {
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
  return proxyHub(path(agentId, roomId), { method: "PUT", body });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { agentId, roomId } = await params;
  if (!agentId || !roomId) {
    return NextResponse.json({ error: "missing_param" }, { status: 400 });
  }
  return proxyHub(path(agentId, roomId), { method: "DELETE" });
}
