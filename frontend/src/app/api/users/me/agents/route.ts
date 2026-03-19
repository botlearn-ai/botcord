import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/../db";
import { userAgents, userRoles, roles } from "@/../db/schema";
import { eq } from "drizzle-orm";
import { verifyBindTicket } from "@/lib/bind-ticket";

/**
 * [INPUT]: 依赖 requireAuth 获取当前用户，依赖 Hub Registry 校验 agent 控制权，依赖 user_agents 表持久化绑定关系
 * [OUTPUT]: 对外提供 GET/POST 用户 agent 管理接口，支持 agent_token 或 bind_proof 绑定
 * [POS]: 前端会话层的用户-agent 绑定 BFF，负责配额、归属、角色授予与安全校验
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

const HUB_API_BASE = process.env.NEXT_PUBLIC_API_BASE || "https://api.botcord.chat";

interface BindProofPayload {
  key_id: string;
  nonce: string;
  sig: string;
}

async function verifyAgentControl(agentId: string, agentToken: string): Promise<boolean> {
  try {
    const statusUrl = new URL(`/registry/agents/${agentId}/endpoints/status`, HUB_API_BASE);
    const response = await fetch(statusUrl.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${agentToken}`,
      },
      cache: "no-store",
    });

    // 401/403 means token is invalid or does not control this agent.
    if (response.status === 401 || response.status === 403) {
      return false;
    }

    // 200 means endpoint exists and auth passed.
    // 404 means auth passed but endpoint is not registered yet.
    if (response.status === 200 || response.status === 404) {
      return true;
    }

    // Treat upstream errors as verification failure to fail closed.
    return false;
  } catch {
    // Network or upstream failure: fail closed.
    return false;
  }
}

async function refreshAgentTokenWithProof(
  agentId: string,
  bindProof: BindProofPayload,
): Promise<string | null> {
  try {
    const refreshUrl = new URL(`/registry/agents/${agentId}/token/refresh`, HUB_API_BASE);
    const response = await fetch(refreshUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key_id: bindProof.key_id,
        nonce: bindProof.nonce,
        sig: bindProof.sig,
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json().catch(() => null);
    if (!data || typeof data.agent_token !== "string" || !data.agent_token.trim()) {
      return null;
    }
    return data.agent_token.trim();
  } catch {
    return null;
  }
}

export async function GET() {
  const { user, error } = await requireAuth();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  return NextResponse.json({
    agents: user.agents.map((a) => ({
      agent_id: a.agentId,
      display_name: a.displayName,
      is_default: a.isDefault,
      claimed_at: a.claimedAt.toISOString(),
    })),
  });
}

export async function POST(request: NextRequest) {
  const { user, error } = await requireAuth();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const body = await request.json();
  const { agent_id, display_name, agent_token, bind_proof, bind_ticket } = body;

  if (!agent_id || typeof agent_id !== "string") {
    return NextResponse.json({ error: "agent_id is required" }, { status: 400 });
  }

  if (!agent_id.startsWith("ag_")) {
    return NextResponse.json({ error: "Invalid agent_id format" }, { status: 400 });
  }

  if (!display_name || typeof display_name !== "string") {
    return NextResponse.json({ error: "display_name is required" }, { status: 400 });
  }

  const hasToken = typeof agent_token === "string" && !!agent_token.trim();
  const hasProof =
    bind_proof &&
    typeof bind_proof === "object" &&
    typeof bind_proof.key_id === "string" &&
    typeof bind_proof.nonce === "string" &&
    typeof bind_proof.sig === "string" &&
    !!bind_proof.key_id.trim() &&
    !!bind_proof.nonce.trim() &&
    !!bind_proof.sig.trim();

  if (!hasToken && !hasProof) {
    return NextResponse.json(
      { error: "Either agent_token or bind_proof is required" },
      { status: 400 },
    );
  }

  let verifiedAgentToken: string | null = null;

  // Prefer bind_proof when provided.
  if (hasProof) {
    if (!bind_ticket || typeof bind_ticket !== "string" || !bind_ticket.trim()) {
      return NextResponse.json(
        { error: "bind_ticket is required when bind_proof is used" },
        { status: 400 },
      );
    }
    const ticketCheck = verifyBindTicket(
      bind_ticket.trim(),
      user.id,
      (bind_proof as BindProofPayload).nonce,
    );
    if (!ticketCheck.ok) {
      return NextResponse.json(
        { error: `invalid bind_ticket: ${ticketCheck.reason}` },
        { status: 403 },
      );
    }

    verifiedAgentToken = await refreshAgentTokenWithProof(agent_id, bind_proof as BindProofPayload);
    if (!verifiedAgentToken) {
      return NextResponse.json(
        { error: "bind_proof does not prove control of this agent_id" },
        { status: 403 },
      );
    }
  } else if (hasToken) {
    const trimmedToken = agent_token.trim();
    const canControlAgent = await verifyAgentControl(agent_id, trimmedToken);
    if (!canControlAgent) {
      return NextResponse.json(
        { error: "agent_token does not prove control of this agent_id" },
        { status: 403 },
      );
    }
    verifiedAgentToken = trimmedToken;
  }

  // Check quota
  if (user.agents.length >= user.maxAgents) {
    return NextResponse.json(
      { error: `Agent limit reached (max ${user.maxAgents})` },
      { status: 400 },
    );
  }

  // Check if agent is already claimed
  const [existing] = await db
    .select()
    .from(userAgents)
    .where(eq(userAgents.agentId, agent_id))
    .limit(1);

  if (existing) {
    return NextResponse.json({ error: "Agent already claimed" }, { status: 409 });
  }

  // Set as default if this is the first agent
  const isDefault = user.agents.length === 0;

  const [newAgent] = await db
    .insert(userAgents)
    .values({
      userId: user.id,
      agentId: agent_id,
      displayName: display_name,
      agentToken: verifiedAgentToken,
      isDefault,
    })
    .returning();

  // Assign agent_owner role if not already assigned
  if (!user.roles.includes("agent_owner")) {
    const [agentOwnerRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, "agent_owner"))
      .limit(1);

    if (agentOwnerRole) {
      await db
        .insert(userRoles)
        .values({ userId: user.id, roleId: agentOwnerRole.id })
        .onConflictDoNothing();
    }
  }

  return NextResponse.json(
    {
      agent_id: newAgent.agentId,
      display_name: newAgent.displayName,
      is_default: newAgent.isDefault,
      claimed_at: newAgent.claimedAt.toISOString(),
    },
    { status: 201 },
  );
}
