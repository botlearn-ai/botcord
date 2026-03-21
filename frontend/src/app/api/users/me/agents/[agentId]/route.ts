import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { db } from "@/../db";
import { agents } from "@/../db/schema";
import { eq, and } from "drizzle-orm";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { user, error } = await requireAuth();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const { agentId } = await params;

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, user.id), eq(agents.agentId, agentId)))
    .limit(1);

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  await db
    .update(agents)
    .set({
      userId: null,
      claimedAt: null,
      isDefault: false,
      agentToken: null,
      tokenExpiresAt: null,
    })
    .where(and(eq(agents.userId, user.id), eq(agents.agentId, agentId)));

  // If deleted agent was default, set another as default
  if (agent.isDefault) {
    const [nextAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, user.id))
      .limit(1);

    if (nextAgent) {
      await db
        .update(agents)
        .set({ isDefault: true })
        .where(eq(agents.id, nextAgent.id));
    }
  }

  return NextResponse.json({ ok: true });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { user, error } = await requireAuth();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const { agentId } = await params;
  const body = await request.json();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, user.id), eq(agents.agentId, agentId)))
    .limit(1);

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (body.is_default === true) {
    // Unset all defaults first
    await db
      .update(agents)
      .set({ isDefault: false })
      .where(eq(agents.userId, user.id));

    // Set this one as default
    await db
      .update(agents)
      .set({ isDefault: true })
      .where(eq(agents.id, agent.id));
  }

  return NextResponse.json({
    agent_id: agent.agentId,
    display_name: agent.displayName,
    is_default: body.is_default === true ? true : agent.isDefault,
    claimed_at: (agent.claimedAt || agent.createdAt).toISOString(),
  });
}
