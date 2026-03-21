import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { shares, shareMessages, rooms } from "@/../db/schema";
import { eq, asc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ shareId: string }> },
) {
  const { shareId } = await params;

  const [share] = await backendDb
    .select({
      shareId: shares.shareId,
      roomId: shares.roomId,
      sharedByAgentId: shares.sharedByAgentId,
      sharedByName: shares.sharedByName,
      createdAt: shares.createdAt,
      expiresAt: shares.expiresAt,
    })
    .from(shares)
    .where(eq(shares.shareId, shareId))
    .limit(1);

  if (!share) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }

  // Check expiration
  if (share.expiresAt && share.expiresAt < new Date()) {
    return NextResponse.json({ error: "Share has expired" }, { status: 410 });
  }

  // Get room info
  const [room] = await backendDb
    .select({
      roomId: rooms.roomId,
      name: rooms.name,
      description: rooms.description,
    })
    .from(rooms)
    .where(eq(rooms.roomId, share.roomId))
    .limit(1);

  // Get messages
  const messages = await backendDb
    .select({
      hubMsgId: shareMessages.hubMsgId,
      msgId: shareMessages.msgId,
      senderId: shareMessages.senderId,
      senderName: shareMessages.senderName,
      type: shareMessages.type,
      text: shareMessages.text,
      payloadJson: shareMessages.payloadJson,
      createdAt: shareMessages.createdAt,
    })
    .from(shareMessages)
    .where(eq(shareMessages.shareId, shareId))
    .orderBy(asc(shareMessages.createdAt));

  return NextResponse.json({
    share: {
      share_id: share.shareId,
      shared_by_agent_id: share.sharedByAgentId,
      shared_by_name: share.sharedByName,
      created_at: share.createdAt.toISOString(),
      expires_at: share.expiresAt?.toISOString() ?? null,
    },
    room: room
      ? {
          room_id: room.roomId,
          name: room.name,
          description: room.description,
        }
      : null,
    messages: messages.map((m) => ({
      hub_msg_id: m.hubMsgId,
      msg_id: m.msgId,
      sender_id: m.senderId,
      sender_name: m.senderName,
      type: m.type,
      text: m.text,
      payload: JSON.parse(m.payloadJson),
      created_at: m.createdAt.toISOString(),
    })),
  });
}
