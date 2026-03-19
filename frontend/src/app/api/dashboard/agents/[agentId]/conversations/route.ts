import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { roomMembers } from "@/../db/schema";
import { sql, inArray } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  const myAgentId = auth.agentId;
  const { agentId: targetAgentId } = await params;

  // Find rooms where both the current agent and the target agent are members
  const sharedRooms = await backendDb.execute<{
    room_id: string;
    name: string;
    description: string;
    owner_id: string;
    visibility: string;
    created_at: string;
  }>(sql`
    SELECT r.room_id, r.name, r.description, r.owner_id, r.visibility, r.created_at
    FROM rooms r
    INNER JOIN room_members m1 ON r.room_id = m1.room_id AND m1.agent_id = ${myAgentId}
    INNER JOIN room_members m2 ON r.room_id = m2.room_id AND m2.agent_id = ${targetAgentId}
    ORDER BY r.created_at DESC
  `);

  // Get member counts
  const roomIds = sharedRooms.map((r) => r.room_id);
  let memberCounts: Record<string, number> = {};
  if (roomIds.length > 0) {
    const counts = await backendDb
      .select({
        roomId: roomMembers.roomId,
        count: sql<number>`count(*)`.as("count"),
      })
      .from(roomMembers)
      .where(inArray(roomMembers.roomId, roomIds))
      .groupBy(roomMembers.roomId);

    for (const c of counts) {
      memberCounts[c.roomId] = c.count;
    }
  }

  return NextResponse.json({
    rooms: sharedRooms.map((r) => ({
      room_id: r.room_id,
      name: r.name,
      description: r.description,
      owner_id: r.owner_id,
      visibility: r.visibility,
      created_at: r.created_at,
      member_count: memberCounts[r.room_id] || 0,
    })),
  });
}
