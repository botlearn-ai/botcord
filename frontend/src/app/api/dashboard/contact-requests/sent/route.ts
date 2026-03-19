import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { agents, contactRequests } from "@/../db/backend-schema";
import { and, desc, eq } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";

export async function GET(request: NextRequest) {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  const { agentId } = auth;

  const state = request.nextUrl.searchParams.get("state");
  const where = state
    ? and(eq(contactRequests.fromAgentId, agentId), eq(contactRequests.state, state))
    : eq(contactRequests.fromAgentId, agentId);

  const rows = await backendDb
    .select({
      id: contactRequests.id,
      fromAgentId: contactRequests.fromAgentId,
      toAgentId: contactRequests.toAgentId,
      state: contactRequests.state,
      message: contactRequests.message,
      createdAt: contactRequests.createdAt,
      resolvedAt: contactRequests.resolvedAt,
      toDisplayName: agents.displayName,
    })
    .from(contactRequests)
    .leftJoin(agents, eq(agents.agentId, contactRequests.toAgentId))
    .where(where)
    .orderBy(desc(contactRequests.createdAt));

  return NextResponse.json({
    requests: rows.map((row) => ({
      id: row.id,
      from_agent_id: row.fromAgentId,
      to_agent_id: row.toAgentId,
      state: row.state,
      message: row.message,
      created_at: row.createdAt.toISOString(),
      resolved_at: row.resolvedAt?.toISOString() ?? null,
      from_display_name: null,
      to_display_name: row.toDisplayName ?? null,
    })),
  });
}
