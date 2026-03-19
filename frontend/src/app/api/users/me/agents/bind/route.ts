import { NextRequest, NextResponse } from "next/server";
import { db } from "@/../db";
import { userAgents, userRoles, roles, users } from "@/../db/schema";
import { and, count, eq } from "drizzle-orm";
import { parseBindTicket } from "@/lib/bind-ticket";

/**
 * [INPUT]: 依赖 bind_ticket 解析出目标用户，依赖 Hub Registry 校验 agent_token 控制权，依赖 user_agents 表持久化绑定关系
 * [OUTPUT]: 对外提供 POST /api/users/me/agents/bind，允许 Agent 使用短时 bind_ticket 自动绑定到用户
 * [POS]: 用户-agent 绑定 BFF 的 agent 侧入口，把“用户发 token、Agent 调 API 完成绑定”收敛为单路由
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

const API_BASE =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "https://api.botcord.chat");

async function verifyAgentControl(agentId: string, agentToken: string): Promise<boolean> {
  try {
    const statusUrl = new URL(`/registry/agents/${agentId}/endpoints/status`, API_BASE);
    const response = await fetch(statusUrl.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${agentToken}`,
      },
      cache: "no-store",
    });

    if (response.status === 401 || response.status === 403) {
      return false;
    }
    if (response.status === 200 || response.status === 404) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const agentId = typeof body?.agent_id === "string" ? body.agent_id.trim() : "";
  const displayNameRaw = typeof body?.display_name === "string" ? body.display_name.trim() : "";
  const agentToken = typeof body?.agent_token === "string" ? body.agent_token.trim() : "";
  const bindTicket = typeof body?.bind_ticket === "string" ? body.bind_ticket.trim() : "";

  if (!agentId) {
    return NextResponse.json({ error: "agent_id is required" }, { status: 400 });
  }
  if (!agentId.startsWith("ag_")) {
    return NextResponse.json({ error: "Invalid agent_id format" }, { status: 400 });
  }
  if (!agentToken) {
    return NextResponse.json({ error: "agent_token is required" }, { status: 400 });
  }
  if (!bindTicket) {
    return NextResponse.json({ error: "bind_ticket is required" }, { status: 400 });
  }

  const parsedTicket = parseBindTicket(bindTicket);
  if (!parsedTicket.ok) {
    return NextResponse.json({ error: `invalid bind_ticket: ${parsedTicket.reason}` }, { status: 403 });
  }

  const canControlAgent = await verifyAgentControl(agentId, agentToken);
  if (!canControlAgent) {
    return NextResponse.json(
      { error: "agent_token does not prove control of this agent_id" },
      { status: 403 },
    );
  }

  const userId = parsedTicket.payload.uid;
  const [user] = await db
    .select({
      id: users.id,
      maxAgents: users.maxAgents,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return NextResponse.json({ error: "Target user not found" }, { status: 404 });
  }

  const [existing] = await db
    .select()
    .from(userAgents)
    .where(eq(userAgents.agentId, agentId))
    .limit(1);

  if (existing) {
    return NextResponse.json({ error: "Agent already claimed" }, { status: 409 });
  }

  const [{ value: ownedAgentCount }] = await db
    .select({ value: count() })
    .from(userAgents)
    .where(eq(userAgents.userId, userId));

  if (ownedAgentCount >= user.maxAgents) {
    return NextResponse.json(
      { error: `Agent limit reached (max ${user.maxAgents})` },
      { status: 400 },
    );
  }

  const displayName = displayNameRaw || `Agent ${agentId.slice(-6)}`;
  const isDefault = ownedAgentCount === 0;

  const [newAgent] = await db
    .insert(userAgents)
    .values({
      userId,
      agentId,
      displayName,
      agentToken,
      isDefault,
    })
    .returning();

  const [agentOwnerRole] = await db
    .select({
      id: roles.id,
    })
    .from(roles)
    .where(eq(roles.name, "agent_owner"))
    .limit(1);

  if (agentOwnerRole) {
    const [existingRole] = await db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, agentOwnerRole.id)))
      .limit(1);

    if (!existingRole) {
      await db.insert(userRoles).values({
        userId,
        roleId: agentOwnerRole.id,
      });
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
