import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { rooms, roomMembers, agents } from "@/../db/backend-schema";
import { eq, and, count } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  const { agentId } = auth;
  const { roomId } = await params;

  // Ensure active agent exists in backend DB (prevents FK 500 on insert)
  const [backendAgent] = await backendDb
    .select({ agentId: agents.agentId })
    .from(agents)
    .where(eq(agents.agentId, agentId))
    .limit(1);

  if (!backendAgent) {
    return NextResponse.json(
      { error: "Active agent not found in backend registry" },
      { status: 404 },
    );
  }

  // Get room
  const [room] = await backendDb
    .select({
      roomId: rooms.roomId,
      visibility: rooms.visibility,
      joinPolicy: rooms.joinPolicy,
      maxMembers: rooms.maxMembers,
      defaultSend: rooms.defaultSend,
      defaultInvite: rooms.defaultInvite,
    })
    .from(rooms)
    .where(eq(rooms.roomId, roomId))
    .limit(1);

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  if (room.visibility !== "public") {
    return NextResponse.json({ error: "Room is not public" }, { status: 403 });
  }

  if (room.joinPolicy !== "open") {
    return NextResponse.json({ error: "Room does not allow open join" }, { status: 403 });
  }

  // Check if already a member
  const [existing] = await backendDb
    .select({ id: roomMembers.id })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (existing) {
    return NextResponse.json({ error: "Already a member of this room" }, { status: 409 });
  }

  // Check max_members
  if (room.maxMembers !== null) {
    const [memberCount] = await backendDb
      .select({ count: count() })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, roomId));

    if (memberCount.count >= room.maxMembers) {
      return NextResponse.json({ error: "Room is full" }, { status: 403 });
    }
  }

  // Join room
  try {
    await backendDb.insert(roomMembers).values({
      roomId,
      agentId,
      role: "member",
      muted: false,
      canSend: room.defaultSend,
      canInvite: room.defaultInvite,
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      return NextResponse.json({ error: "Already a member of this room" }, { status: 409 });
    }
    if (code === "23503") {
      return NextResponse.json({ error: "Invalid room or agent reference" }, { status: 400 });
    }
    throw err;
  }

  return NextResponse.json({
    room_id: roomId,
    agent_id: agentId,
    role: "member",
    joined: true,
  });
}
