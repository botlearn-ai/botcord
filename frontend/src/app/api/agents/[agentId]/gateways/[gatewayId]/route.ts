/**
 * [INPUT]: agentId + gatewayId from path; PATCH body is a partial update
 * [OUTPUT]: PATCH/DELETE /api/agents/[agentId]/gateways/[gatewayId] — proxies to Hub
 * [POS]: BFF endpoints for the AgentSettingsDrawer "Channels" tab
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyHub } from "../../../../_lib/proxy-hub";

type Params = { params: Promise<{ agentId: string; gatewayId: string }> };

function path(agentId: string, gatewayId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/gateways/${encodeURIComponent(gatewayId)}`;
}

export async function PATCH(req: Request, { params }: Params) {
  const { agentId, gatewayId } = await params;
  if (!agentId || !gatewayId) {
    return NextResponse.json({ error: "missing_param" }, { status: 400 });
  }
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return proxyHub(path(agentId, gatewayId), { method: "PATCH", body });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { agentId, gatewayId } = await params;
  if (!agentId || !gatewayId) {
    return NextResponse.json({ error: "missing_param" }, { status: 400 });
  }
  return proxyHub(path(agentId, gatewayId), { method: "DELETE" });
}
