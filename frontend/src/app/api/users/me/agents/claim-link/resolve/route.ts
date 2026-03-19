import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { issueBindTicket } from "@/lib/bind-ticket";

/**
 * [INPUT]: 依赖 requireAuth 获取用户身份，依赖 Backend Registry 校验 token，并签发当前用户 bind_ticket
 * [OUTPUT]: 对外提供 POST /api/users/me/agents/claim-link/resolve 返回认领上下文
 * [POS]: 认领链接落地页的安全解析器，解包 agent_id 并绑定到当前登录用户的一次性 bind_ticket
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

const API_BASE = process.env.NEXT_PUBLIC_HUB_BASE_URL || "https://api.botcord.chat";

export async function POST(request: NextRequest) {
  const { user, error } = await requireAuth();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const body = await request.json().catch(() => ({}));
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  try {
    const upstream = new URL("/registry/claim-links/resolve", API_BASE);
    const resp = await fetch(upstream.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const error = data?.detail || data?.error || "invalid claim token";
      return NextResponse.json({ error }, { status: resp.status });
    }

    const agentId = typeof data?.agent_id === "string" ? data.agent_id : "";
    const displayName = typeof data?.display_name === "string" ? data.display_name : "";
    const claimExpiresAt = Number(data?.expires_at || 0);
    if (!agentId || !displayName || !Number.isFinite(claimExpiresAt) || claimExpiresAt <= 0) {
      return NextResponse.json({ error: "invalid claim resolve response" }, { status: 502 });
    }

    const bindIssued = issueBindTicket(user.id, 300);
    return NextResponse.json({
      agent_id: agentId,
      display_name: displayName,
      bind_ticket: bindIssued.bindTicket,
      nonce: bindIssued.nonce,
      expires_at: Math.min(claimExpiresAt, bindIssued.expiresAt),
    });
  } catch {
    return NextResponse.json({ error: "Failed to resolve claim token" }, { status: 502 });
  }
}
