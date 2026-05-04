/**
 * [INPUT]: agentId from path; POST body { loginId, timeoutSeconds? }
 * [OUTPUT]: POST /api/agents/[agentId]/gateways/wechat/senders — proxies to Hub
 * [POS]: BFF helper for discovering WeChat allowedSenderIds after scan login
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyHub } from "../../../../../_lib/proxy-hub";

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
    `/api/agents/${encodeURIComponent(agentId)}/gateways/wechat/senders`,
    { method: "POST", body },
  );
}
