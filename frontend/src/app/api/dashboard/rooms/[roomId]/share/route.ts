import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import {
  agents,
  rooms,
  roomMembers,
  shares,
  shareMessages,
} from "@/../db/backend-schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";
import { extractTextFromEnvelope } from "@/app/api/_helpers";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  const { agentId } = auth;
  const { roomId } = await params;

  // Verify membership
  const [membership] = await backendDb
    .select({ id: roomMembers.id })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (!membership) {
    return NextResponse.json({ error: "Not a member of this room" }, { status: 403 });
  }

  // Get agent display name
  const [agent] = await backendDb
    .select({ displayName: agents.displayName })
    .from(agents)
    .where(eq(agents.agentId, agentId))
    .limit(1);

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Get room info
  const [room] = await backendDb
    .select({ name: rooms.name })
    .from(rooms)
    .where(eq(rooms.roomId, roomId))
    .limit(1);

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  // Optional expiration from body
  let expiresAt: Date | null = null;
  try {
    const body = (await request.json()) as { expires_in_hours?: number };
    if (body.expires_in_hours && body.expires_in_hours > 0) {
      expiresAt = new Date(Date.now() + body.expires_in_hours * 3600 * 1000);
    }
  } catch {
    // no body or invalid JSON is fine
  }

  const shareId = `sh_${crypto.randomBytes(6).toString("hex")}`;

  // Create share record
  await backendDb.insert(shares).values({
    shareId,
    roomId,
    sharedByAgentId: agentId,
    sharedByName: agent.displayName,
    expiresAt,
  });

  // Get deduped messages for this room (latest 200)
  const msgs = await backendDb.execute<{
    hub_msg_id: string;
    msg_id: string;
    sender_id: string;
    envelope_json: string;
    created_at: string;
  }>(sql`
    SELECT mr.hub_msg_id, mr.msg_id, mr.sender_id, mr.envelope_json, mr.created_at
    FROM message_records mr
    INNER JOIN (
      SELECT msg_id, MIN(id) AS min_id
      FROM message_records
      WHERE room_id = ${roomId}
      GROUP BY msg_id
    ) dedup ON mr.id = dedup.min_id
    WHERE mr.room_id = ${roomId}
    ORDER BY mr.id DESC
    LIMIT 200
  `);

  // Get sender display names
  const senderIds = [...new Set(msgs.map((m) => m.sender_id))];
  const senderNames: Record<string, string> = {};
  if (senderIds.length > 0) {
    const senders = await backendDb
      .select({ agent_id: agents.agentId, display_name: agents.displayName })
      .from(agents)
      .where(inArray(agents.agentId, senderIds));
    for (const s of senders) {
      senderNames[s.agent_id] = s.display_name;
    }
  }

  // Insert share messages
  if (msgs.length > 0) {
    const shareMessageValues = msgs.map((msg) => {
      let text = "";
      let msgType = "message";
      let payloadJson = "{}";
      try {
        const envelope = JSON.parse(msg.envelope_json) as Record<string, unknown>;
        const extracted = extractTextFromEnvelope(envelope);
        text = extracted.text;
        msgType = (envelope.type as string) || "message";
        payloadJson = JSON.stringify(extracted.payload);
      } catch {
        // ignore
      }
      return {
        shareId,
        hubMsgId: msg.hub_msg_id,
        msgId: msg.msg_id,
        senderId: msg.sender_id,
        senderName: senderNames[msg.sender_id] || msg.sender_id,
        type: msgType,
        text,
        payloadJson,
        createdAt: new Date(msg.created_at),
      };
    });

    await backendDb.insert(shareMessages).values(shareMessageValues);
  }

  return NextResponse.json({
    share_id: shareId,
    room_id: roomId,
    room_name: room.name,
    message_count: msgs.length,
    expires_at: expiresAt?.toISOString() ?? null,
  });
}
