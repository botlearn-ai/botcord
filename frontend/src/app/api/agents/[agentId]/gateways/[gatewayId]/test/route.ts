/**
 * [INPUT]: agentId + gatewayId from path
 * [OUTPUT]: POST /api/agents/[agentId]/gateways/[gatewayId]/test — proxies to Hub
 * [POS]: BFF endpoint for the per-row "test connection" button
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyHub } from "../../../../../_lib/proxy-hub";

type Params = { params: Promise<{ agentId: string; gatewayId: string }> };

export async function POST(_req: Request, { params }: Params) {
  const { agentId, gatewayId } = await params;
  if (!agentId || !gatewayId) {
    return NextResponse.json({ error: "missing_param" }, { status: 400 });
  }
  return proxyHub(
    `/api/agents/${encodeURIComponent(agentId)}/gateways/${encodeURIComponent(gatewayId)}/test`,
    { method: "POST" },
  );
}
