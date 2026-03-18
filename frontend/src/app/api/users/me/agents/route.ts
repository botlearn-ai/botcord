import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/../db";
import { userAgents, userRoles, roles } from "@/../db/schema";
import { eq } from "drizzle-orm";

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
  const { agent_id, display_name } = body;

  if (!agent_id || typeof agent_id !== "string") {
    return NextResponse.json({ error: "agent_id is required" }, { status: 400 });
  }

  if (!agent_id.startsWith("ag_")) {
    return NextResponse.json({ error: "Invalid agent_id format" }, { status: 400 });
  }

  if (!display_name || typeof display_name !== "string") {
    return NextResponse.json({ error: "display_name is required" }, { status: 400 });
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
