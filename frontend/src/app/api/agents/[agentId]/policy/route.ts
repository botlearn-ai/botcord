/**
 * [INPUT]: agentId from path; PATCH body is a partial AgentPolicy
 * [OUTPUT]: GET/PATCH /api/agents/[agentId]/policy — proxies to Hub /api/agents/{id}/policy
 * [POS]: BFF endpoints for the global per-agent policy form
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyHub } from "../../../_lib/proxy-hub";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  if (!agentId) {
    return NextResponse.json({ error: "missing_agent_id" }, { status: 400 });
  }
  return proxyHub(`/api/agents/${encodeURIComponent(agentId)}/policy`, {
    method: "GET",
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
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
  return proxyHub(`/api/agents/${encodeURIComponent(agentId)}/policy`, {
    method: "PATCH",
    body,
  });
}
