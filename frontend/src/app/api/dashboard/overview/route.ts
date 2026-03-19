import { NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import {
  agents,
  rooms,
  roomMembers,
  contacts,
  contactRequests,
  messageRecords,
} from "@/../db/backend-schema";
import { eq, and, count, desc } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";
import { extractTextFromEnvelope } from "@/app/api/_helpers";

export async function GET() {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  const { agentId } = auth;

  // Agent profile
  const [profile] = await backendDb
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

  if (!profile) {
    return NextResponse.json({ error: "Agent not found in backend" }, { status: 404 });
  }

  // Rooms the agent is a member of
  const memberRooms = await backendDb
    .select({
      roomId: rooms.roomId,
      name: rooms.name,
      description: rooms.description,
      rule: rooms.rule,
      ownerId: rooms.ownerId,
      visibility: rooms.visibility,
      role: roomMembers.role,
      joinedAt: roomMembers.joinedAt,
    })
    .from(roomMembers)
    .innerJoin(rooms, eq(roomMembers.roomId, rooms.roomId))
    .where(eq(roomMembers.agentId, agentId))
    .orderBy(desc(roomMembers.joinedAt));

  // Add last message preview
  const roomsWithPreview = await Promise.all(
    memberRooms.map(async (room) => {
      const [memberCountRow] = await backendDb
        .select({ count: count() })
        .from(roomMembers)
        .where(eq(roomMembers.roomId, room.roomId));

      const [lastMsg] = await backendDb
        .select({
          msgId: messageRecords.msgId,
          hubMsgId: messageRecords.hubMsgId,
          senderId: messageRecords.senderId,
          envelopeJson: messageRecords.envelopeJson,
          createdAt: messageRecords.createdAt,
        })
        .from(messageRecords)
        .where(eq(messageRecords.roomId, room.roomId))
        .orderBy(desc(messageRecords.createdAt))
        .limit(1);

      let lastMessagePreview: string | null = null;
      let lastMessageAt: string | null = null;
      if (lastMsg) {
        try {
          const envelope = JSON.parse(lastMsg.envelopeJson) as Record<string, unknown>;
          const { text } = extractTextFromEnvelope(envelope);
          lastMessagePreview = text.slice(0, 200);
          lastMessageAt = lastMsg.createdAt.toISOString();
        } catch {
          // ignore
        }
      }

      return {
        room_id: room.roomId,
        name: room.name,
        description: room.description,
        rule: room.rule,
        owner_id: room.ownerId,
        visibility: room.visibility,
        member_count: memberCountRow.count,
        my_role: room.role,
        last_message_preview: lastMessagePreview,
        last_message_at: lastMessageAt,
        last_sender_name: lastMsg?.senderId ?? null,
      };
    }),
  );

  // Contacts
  const contactList = await backendDb
    .select({
      contactAgentId: contacts.contactAgentId,
      alias: contacts.alias,
      createdAt: contacts.createdAt,
      displayName: agents.displayName,
      bio: agents.bio,
    })
    .from(contacts)
    .innerJoin(agents, eq(contacts.contactAgentId, agents.agentId))
    .where(eq(contacts.ownerId, agentId));

  // Pending contact request count
  const [pendingCount] = await backendDb
    .select({ count: count() })
    .from(contactRequests)
    .where(and(eq(contactRequests.toAgentId, agentId), eq(contactRequests.state, "pending")));

  return NextResponse.json({
    agent: {
      agent_id: profile.agentId,
      display_name: profile.displayName,
      bio: profile.bio,
      message_policy: profile.messagePolicy,
      created_at: profile.createdAt.toISOString(),
    },
    rooms: roomsWithPreview,
    contacts: contactList.map((c) => ({
      contact_agent_id: c.contactAgentId,
      alias: c.alias,
      display_name: c.displayName,
      created_at: c.createdAt.toISOString(),
    })),
    pending_requests: pendingCount.count,
  });
}
