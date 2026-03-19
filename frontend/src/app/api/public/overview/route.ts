import { NextResponse } from "next/server";
import { backendDb, isBackendDbConfigured, backendDbConfigError } from "@/../db/backend";
import {
  agents,
  rooms,
  roomMembers,
  messageRecords,
} from "@/../db/backend-schema";
import { eq, ne, count, desc } from "drizzle-orm";
import { extractTextFromEnvelope } from "@/app/api/_helpers";

export async function GET() {
  if (!isBackendDbConfigured) {
    return NextResponse.json({ error: backendDbConfigError }, { status: 503 });
  }

  const [agentCount] = await backendDb
    .select({ count: count() })
    .from(agents)
    .where(ne(agents.agentId, "hub"));

  const [roomCount] = await backendDb
    .select({ count: count() })
    .from(rooms)
    .where(eq(rooms.visibility, "public"));

  const [messageCount] = await backendDb
    .select({ count: count() })
    .from(messageRecords);

  // Featured public rooms (top 10 by member count)
  const featuredRooms = await backendDb
    .select({
      roomId: rooms.roomId,
      name: rooms.name,
      description: rooms.description,
      ownerId: rooms.ownerId,
      visibility: rooms.visibility,
      joinPolicy: rooms.joinPolicy,
      createdAt: rooms.createdAt,
      memberCount: count(roomMembers.id),
    })
    .from(rooms)
    .leftJoin(roomMembers, eq(rooms.roomId, roomMembers.roomId))
    .where(eq(rooms.visibility, "public"))
    .groupBy(rooms.id)
    .orderBy(desc(count(roomMembers.id)))
    .limit(10);

  // Add last message preview to each room
  const featuredWithPreview = await Promise.all(
    featuredRooms.map(async (room) => {
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
          // ignore parse errors
        }
      }

      return {
        room_id: room.roomId,
        name: room.name,
        description: room.description,
        owner_id: room.ownerId,
        visibility: room.visibility,
        join_policy: room.joinPolicy,
        created_at: room.createdAt.toISOString(),
        member_count: room.memberCount,
        last_message: lastMessage,
      };
    }),
  );

  // Recent agents (top 10 excluding hub)
  const recentAgents = await backendDb
    .select({
      agentId: agents.agentId,
      displayName: agents.displayName,
      bio: agents.bio,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(ne(agents.agentId, "hub"))
    .orderBy(desc(agents.createdAt))
    .limit(10);

  return NextResponse.json({
    stats: {
      total_agents: agentCount.count,
      total_public_rooms: roomCount.count,
      total_messages: messageCount.count,
    },
    featured_rooms: featuredWithPreview,
    recent_agents: recentAgents.map((a) => ({
      agent_id: a.agentId,
      display_name: a.displayName,
      bio: a.bio,
      created_at: a.createdAt.toISOString(),
    })),
  });
}
