/**
 * [INPUT]: agentId from path; POST body is a third-party gateway create payload
 * [OUTPUT]: GET/POST /api/agents/[agentId]/gateways — proxies to Hub
 * [POS]: BFF endpoints for the AgentSettingsDrawer "Channels" tab
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyHub } from "../../../_lib/proxy-hub";

type Params = { params: Promise<{ agentId: string }> };

function path(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/gateways`;
}

export async function GET(_req: Request, { params }: Params) {
  const { agentId } = await params;
  if (!agentId) {
    return NextResponse.json({ error: "missing_agent_id" }, { status: 400 });
  }
  return proxyHub(path(agentId), { method: "GET" });
}

export async function POST(req: Request, { params }: Params) {
  const { agentId } = await params;
  if (!agentId) {
    return NextResponse.json({ error: "missing_agent_id" }, { status: 400 });
  }
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return proxyHub(path(agentId), { method: "POST", body });
}
