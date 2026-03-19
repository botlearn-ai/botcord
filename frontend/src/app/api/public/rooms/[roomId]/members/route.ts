import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { rooms, roomMembers, agents } from "@/../db/backend-schema";
import { eq } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;

  // Verify room is public
  const [room] = await backendDb
    .select({ visibility: rooms.visibility })
    .from(rooms)
    .where(eq(rooms.roomId, roomId))
    .limit(1);

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }
  if (room.visibility !== "public") {
    return NextResponse.json({ error: "Room is not public" }, { status: 403 });
  }

  const members = await backendDb
    .select({
      agentId: roomMembers.agentId,
      role: roomMembers.role,
      joinedAt: roomMembers.joinedAt,
      displayName: agents.displayName,
      bio: agents.bio,
    })
    .from(roomMembers)
    .innerJoin(agents, eq(roomMembers.agentId, agents.agentId))
    .where(eq(roomMembers.roomId, roomId));

  return NextResponse.json({
    members: members.map((m) => ({
      agent_id: m.agentId,
      display_name: m.displayName,
      bio: m.bio,
      role: m.role,
      joined_at: m.joinedAt.toISOString(),
    })),
  });
}
