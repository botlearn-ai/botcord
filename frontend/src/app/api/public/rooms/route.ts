import { NextRequest, NextResponse } from "next/server";
import { backendDb, isBackendDbConfigured, backendDbConfigError } from "@/../db/backend";
import { rooms, roomMembers, messageRecords } from "@/../db/backend-schema";
import { eq, count, desc, ilike, and } from "drizzle-orm";
import { extractTextFromEnvelope, escapeLike } from "@/app/api/_helpers";

export async function GET(request: NextRequest) {
  if (!isBackendDbConfigured) {
    return NextResponse.json({ error: backendDbConfigError }, { status: 503 });
  }

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q") || "";
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "20", 10), 1), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") || "0", 10), 0);

  const conditions = [eq(rooms.visibility, "public")];
  if (q) {
    const escaped = escapeLike(q);
    conditions.push(ilike(rooms.name, `%${escaped}%`));
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
      visibility: rooms.visibility,
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

  const roomsWithPreview = await Promise.all(
    roomList.map(async (room) => {
      const [lastMsg] = await backendDb
        .select({
          msgId: messageRecords.msgId,
          senderId: messageRecords.senderId,
          envelopeJson: messageRecords.envelopeJson,
          createdAt: messageRecords.createdAt,
        })
        .from(messageRecords)
        .where(eq(messageRecords.roomId, room.roomId))
        .orderBy(desc(messageRecords.createdAt))
        .limit(1);

      let lastMessage = null;
      if (lastMsg) {
        try {
          const envelope = JSON.parse(lastMsg.envelopeJson) as Record<string, unknown>;
          const { text } = extractTextFromEnvelope(envelope);
          lastMessage = {
            msg_id: lastMsg.msgId,
            sender_id: lastMsg.senderId,
            text: text.slice(0, 200),
            created_at: lastMsg.createdAt.toISOString(),
          };
        } catch {
          // ignore
        }
      }

      return {
        room_id: room.roomId,
        name: room.name,
        description: room.description,
        owner_id: room.ownerId,
        visibility: room.visibility,
        join_policy: room.joinPolicy,
        max_members: room.maxMembers,
        created_at: room.createdAt.toISOString(),
        member_count: room.memberCount,
        last_message: lastMessage,
      };
    }),
  );

  return NextResponse.json({
    total: totalResult.count,
    limit,
    offset,
    rooms: roomsWithPreview,
  });
}
