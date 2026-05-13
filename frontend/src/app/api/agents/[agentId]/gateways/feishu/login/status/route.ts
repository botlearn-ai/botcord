/**
 * [INPUT]: agentId from path; POST body { loginId }
 * [OUTPUT]: POST /api/agents/[agentId]/gateways/feishu/login/status — proxies to Hub
 * [POS]: BFF endpoint polled by the Feishu scan-to-create-bot dialog
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyHub } from "../../../../../../_lib/proxy-hub";

type Params = { params: Promise<{ agentId: string }> };

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
  return proxyHub(
    `/api/agents/${encodeURIComponent(agentId)}/gateways/feishu/login/status`,
    { method: "POST", body },
  );
}
