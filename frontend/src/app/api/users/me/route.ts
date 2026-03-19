import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

export async function GET() {
  const { user, error } = await requireAuth();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  return NextResponse.json({
    id: user.id,
    display_name: user.displayName,
    email: user.email,
    avatar_url: user.avatarUrl,
    status: user.status,
    max_agents: user.maxAgents,
    roles: user.roles,
    agents: user.agents.map((a) => ({
      agent_id: a.agentId,
      display_name: a.displayName,
      is_default: a.isDefault,
      claimed_at: a.claimedAt.toISOString(),
    })),
  });
}
