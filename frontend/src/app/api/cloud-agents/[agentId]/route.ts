/**
 * [INPUT]: agentId from path; Supabase session via proxyHub
 * [OUTPUT]: DELETE /api/cloud-agents/[agentId] — proxies to Hub Cloud Agent deletion
 * [POS]: BFF endpoint for deleting cloud-hosted Bot instances from dashboard settings
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyHub } from "../../_lib/proxy-hub";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  if (!agentId) {
    return NextResponse.json({ error: "missing_agent_id" }, { status: 400 });
  }
  return proxyHub(`/api/cloud-agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
}
