import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { agents } from "@/../db/backend-schema";
import { eq } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;

  const [agent] = await backendDb
    .select({
      agentId: agents.agentId,
      displayName: agents.displayName,
      bio: agents.bio,
      messagePolicy: agents.messagePolicy,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(eq(agents.agentId, agentId))
    .limit(1);

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({
    agent_id: agent.agentId,
    display_name: agent.displayName,
    bio: agent.bio,
    message_policy: agent.messagePolicy,
    created_at: agent.createdAt.toISOString(),
  });
}
