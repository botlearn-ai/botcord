import { NextRequest, NextResponse } from "next/server";

/**
 * [INPUT]: 依赖 Agent Bearer Token，转发到 Backend Registry 生成认领链接
 * [OUTPUT]: 对外提供 POST /api/users/me/agents/claim 返回 claim_url + expires_at
 * [POS]: frontend BFF 的 agent 侧转发器，保持浏览器同域调用习惯
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

const API_BASE = process.env.NEXT_PUBLIC_HUB_BASE_URL || "https://api.botcord.chat";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const agentIdRaw = typeof body?.agent_id === "string" ? body.agent_id.trim() : "";
  const displayNameRaw = typeof body?.display_name === "string" ? body.display_name.trim() : "";
  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const bodyToken = typeof body?.agent_token === "string" ? body.agent_token.trim() : "";
  const agentToken = bearerToken || bodyToken;

  if (!agentIdRaw) {
    return NextResponse.json({ error: "agent_id is required" }, { status: 400 });
  }
  if (!agentIdRaw.startsWith("ag_")) {
    return NextResponse.json({ error: "Invalid agent_id format" }, { status: 400 });
  }
  if (!agentToken) {
    return NextResponse.json(
      { error: "agent_token (or Authorization: Bearer) is required" },
      { status: 401 },
    );
  }

  const displayName = displayNameRaw || `Agent ${agentIdRaw.slice(-6)}`;
  try {
    const upstream = new URL(`/registry/agents/${agentIdRaw}/claim`, API_BASE);
    const resp = await fetch(upstream.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({
        display_name: displayName,
      }),
      cache: "no-store",
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const error = data?.detail || data?.error || "Failed to create claim link";
      return NextResponse.json({ error }, { status: resp.status });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to create claim link" }, { status: 502 });
  }
}
