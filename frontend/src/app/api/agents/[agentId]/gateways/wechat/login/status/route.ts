/**
 * [INPUT]: agentId from path; POST body { loginId }
 * [OUTPUT]: POST /api/agents/[agentId]/gateways/wechat/login/status — proxies to Hub
 * [POS]: BFF endpoint polled by the WeChat scan-to-login dialog
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
    `/api/agents/${encodeURIComponent(agentId)}/gateways/wechat/login/status`,
    { method: "POST", body },
  );
}
