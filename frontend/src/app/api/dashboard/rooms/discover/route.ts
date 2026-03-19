import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { rooms, roomMembers } from "@/../db/backend-schema";
import { eq, and, count, desc, notInArray } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";

export async function GET(request: NextRequest) {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  const { agentId } = auth;

  const { searchParams } = request.nextUrl;
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "20", 10), 1), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") || "0", 10), 0);

  // Get rooms the agent is already a member of
  const joinedRoomIds = await backendDb
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .where(eq(roomMembers.agentId, agentId));

  const joinedIds = joinedRoomIds.map((r) => r.roomId);

  const conditions = [eq(rooms.visibility, "public")];
  if (joinedIds.length > 0) {
    conditions.push(notInArray(rooms.roomId, joinedIds));
  }
  const whereClause = and(...conditions);

  const [totalResult] = await backendDb
    .select({ count: count() })
    .from(rooms)
    .where(whereClause);

  const roomList = await backendDb
    .select({
      roomId: rooms.roomId,
      name: rooms.name,
      description: rooms.description,
      ownerId: rooms.ownerId,
      joinPolicy: rooms.joinPolicy,
      maxMembers: rooms.maxMembers,
      createdAt: rooms.createdAt,
      memberCount: count(roomMembers.id),
    })
    .from(rooms)
    .leftJoin(roomMembers, eq(rooms.roomId, roomMembers.roomId))
    .where(whereClause)
    .groupBy(rooms.id)
    .orderBy(desc(rooms.createdAt))
    .limit(limit)
    .offset(offset);

  return NextResponse.json({
    total: totalResult.count,
    limit,
    offset,
    rooms: roomList.map((r) => ({
      room_id: r.roomId,
      name: r.name,
      description: r.description,
      owner_id: r.ownerId,
      join_policy: r.joinPolicy,
      max_members: r.maxMembers,
      created_at: r.createdAt.toISOString(),
      member_count: r.memberCount,
    })),
  });
}
