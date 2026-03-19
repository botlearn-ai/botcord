import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { agents, contacts, contactRequests } from "@/../db/backend-schema";
import { and, eq } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";

export async function POST(request: NextRequest) {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  const { agentId } = auth;

  const body = (await request.json().catch(() => ({}))) as {
    to_agent_id?: string;
    message?: string;
  };
  const toAgentId = (body.to_agent_id || "").trim();
  const message = body.message?.trim() || null;

  if (!toAgentId) {
    return NextResponse.json({ error: "to_agent_id is required" }, { status: 400 });
  }
  if (toAgentId === agentId) {
    return NextResponse.json({ error: "Cannot send contact request to yourself" }, { status: 400 });
  }

  const [target] = await backendDb
    .select({ agentId: agents.agentId, displayName: agents.displayName })
    .from(agents)
    .where(eq(agents.agentId, toAgentId))
    .limit(1);
  if (!target) {
    return NextResponse.json({ error: "Target agent not found" }, { status: 404 });
  }

  const [existingContact] = await backendDb
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.ownerId, agentId), eq(contacts.contactAgentId, toAgentId)))
    .limit(1);
  if (existingContact) {
    return NextResponse.json({ error: "Already in contacts" }, { status: 409 });
  }

  const [existingRequest] = await backendDb
    .select({
      id: contactRequests.id,
      state: contactRequests.state,
      createdAt: contactRequests.createdAt,
    })
    .from(contactRequests)
    .where(and(eq(contactRequests.fromAgentId, agentId), eq(contactRequests.toAgentId, toAgentId)))
    .limit(1);

  if (existingRequest?.state === "pending") {
    return NextResponse.json({ error: "Contact request already pending" }, { status: 409 });
  }
  if (existingRequest?.state === "accepted") {
    return NextResponse.json({ error: "Contact request already accepted" }, { status: 409 });
  }

  let requestId = existingRequest?.id ?? null;
  if (existingRequest) {
    await backendDb
      .update(contactRequests)
      .set({
        state: "pending",
        message,
        resolvedAt: null,
      })
      .where(eq(contactRequests.id, existingRequest.id));
    requestId = existingRequest.id;
  } else {
    const [inserted] = await backendDb
      .insert(contactRequests)
      .values({
        fromAgentId: agentId,
        toAgentId,
        state: "pending",
        message,
      })
      .returning({ id: contactRequests.id });
    requestId = inserted.id;
  }

  const [created] = await backendDb
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
    .where(eq(contactRequests.id, requestId!))
    .limit(1);

  return NextResponse.json(
    {
      id: created.id,
      from_agent_id: created.fromAgentId,
      to_agent_id: created.toAgentId,
      state: created.state,
      message: created.message,
      created_at: created.createdAt.toISOString(),
      resolved_at: created.resolvedAt?.toISOString() ?? null,
      from_display_name: null,
      to_display_name: target.displayName ?? null,
    },
    { status: 201 },
  );
}
