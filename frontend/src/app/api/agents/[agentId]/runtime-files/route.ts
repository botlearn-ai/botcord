/**
 * [INPUT]: agentId from path; optional file_id query
 * [OUTPUT]: GET /api/agents/[agentId]/runtime-files — proxies to Hub runtime-files API
 * [POS]: BFF endpoint for AgentSettingsDrawer 文件/记忆 tab
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyHub } from "../../../_lib/proxy-hub";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;
  if (!agentId) {
    return NextResponse.json({ error: "missing_agent_id" }, { status: 400 });
  }
  const url = new URL(req.url);
  const fileId = url.searchParams.get("file_id");
  const query = fileId ? `?file_id=${encodeURIComponent(fileId)}` : "";
  return proxyHub(
    `/api/agents/${encodeURIComponent(agentId)}/runtime-files${query}`,
    { method: "GET" },
  );
}
