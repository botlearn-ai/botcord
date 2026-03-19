import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/../db";
import { agents, roles, userRoles } from "@/../db/schema";
import { and, count, eq, isNull } from "drizzle-orm";

/**
 * [INPUT]: 依赖 requireAuth 获取用户身份，依赖 claim_code 在 agents 表定位可认领 agent
 * [OUTPUT]: 对外提供 POST /api/users/me/agents/claim/resolve，登录后凭 claim_code 直接完成认领
 * [POS]: 固定认领码落地页的最终认领入口，不要求 agent_token 或与 Agent 二次交互
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

export async function POST(request: NextRequest) {
  const { user, error } = await requireAuth();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const body = await request.json().catch(() => ({}));
  const claimCode = typeof body?.claim_code === "string" ? body.claim_code.trim() : "";
  if (!claimCode) {
    return NextResponse.json({ error: "claim_code is required" }, { status: 400 });
  }

  const [existing] = await db
    .select()
    .from(agents)
    .where(eq(agents.claimCode, claimCode))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "Invalid claim code" }, { status: 404 });
  }

  if (existing.userId) {
    return NextResponse.json({ error: "Agent already claimed" }, { status: 409 });
  }

  if (user.agents.length >= user.maxAgents) {
    return NextResponse.json(
      { error: `Agent limit reached (max ${user.maxAgents})` },
      { status: 400 },
    );
  }

  const [{ value: ownedAgentCount }] = await db
    .select({ value: count() })
    .from(agents)
    .where(eq(agents.userId, user.id));
  const isDefault = ownedAgentCount === 0;

  const claimedRows = await db
    .update(agents)
    .set({
      userId: user.id,
      isDefault,
      claimedAt: new Date(),
    })
    .where(and(eq(agents.id, existing.id), isNull(agents.userId)))
    .returning();

  const claimed = claimedRows[0];
  if (!claimed) {
    return NextResponse.json({ error: "Agent already claimed" }, { status: 409 });
  }

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

    return NextResponse.json({
      agent_id: claimed.agentId,
      display_name: claimed.displayName,
      is_default: claimed.isDefault,
      claimed_at: (claimed.claimedAt || claimed.createdAt).toISOString(),
    });
}
