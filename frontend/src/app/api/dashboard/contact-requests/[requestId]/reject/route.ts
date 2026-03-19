import { NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { contactRequests } from "@/../db/schema";
import { and, eq } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  const { agentId } = auth;
  const { requestId } = await params;
  const id = Number(requestId);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid request id" }, { status: 400 });
  }

  const [requestRow] = await backendDb
    .select({
      id: contactRequests.id,
      fromAgentId: contactRequests.fromAgentId,
      toAgentId: contactRequests.toAgentId,
      state: contactRequests.state,
      message: contactRequests.message,
      createdAt: contactRequests.createdAt,
      resolvedAt: contactRequests.resolvedAt,
    })
    .from(contactRequests)
    .where(and(eq(contactRequests.id, id), eq(contactRequests.toAgentId, agentId)))
    .limit(1);

  if (!requestRow) {
    return NextResponse.json({ error: "Contact request not found" }, { status: 404 });
  }
  if (requestRow.state !== "pending") {
    return NextResponse.json({ error: `Contact request is already ${requestRow.state}` }, { status: 400 });
  }

  await backendDb
    .update(contactRequests)
    .set({ state: "rejected", resolvedAt: new Date() })
    .where(eq(contactRequests.id, id));

  const [updated] = await backendDb
    .select({
      id: contactRequests.id,
      fromAgentId: contactRequests.fromAgentId,
      toAgentId: contactRequests.toAgentId,
      state: contactRequests.state,
      message: contactRequests.message,
      createdAt: contactRequests.createdAt,
      resolvedAt: contactRequests.resolvedAt,
    })
    .from(contactRequests)
    .where(eq(contactRequests.id, id))
    .limit(1);

  return NextResponse.json({
    id: updated.id,
    from_agent_id: updated.fromAgentId,
    to_agent_id: updated.toAgentId,
    state: updated.state,
    message: updated.message,
    created_at: updated.createdAt.toISOString(),
    resolved_at: updated.resolvedAt?.toISOString() ?? null,
    from_display_name: null,
    to_display_name: null,
  });
}
