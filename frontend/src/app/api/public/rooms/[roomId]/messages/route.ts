import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { rooms, messageRecords } from "@/../db/backend-schema";
import { eq, and, sql } from "drizzle-orm";
import { extractTextFromEnvelope } from "@/app/api/_helpers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;
  const { searchParams } = request.nextUrl;
  const before = searchParams.get("before");
  const cursor = searchParams.get("cursor");
  const effectiveBefore = before || cursor;
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "50", 10), 1), 100);

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

  // Dedup fan-out: group by msg_id, pick min(id) to get one copy per logical message
  let cursorCondition = sql``;
  if (effectiveBefore) {
    const [cursorRow] = await backendDb
      .select({ id: messageRecords.id })
      .from(messageRecords)
      .where(and(eq(messageRecords.hubMsgId, effectiveBefore), eq(messageRecords.roomId, roomId)))
      .limit(1);
    if (!cursorRow) {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    }
    cursorCondition = sql`AND mr.id < ${cursorRow.id}`;
  }

  const rows = await backendDb.execute<{
    id: number;
    hub_msg_id: string;
    msg_id: string;
    sender_id: string;
    envelope_json: string;
    room_id: string | null;
    topic: string | null;
    topic_id: string | null;
    state: string;
    created_at: string;
  }>(sql`
    SELECT mr.id, mr.hub_msg_id, mr.msg_id, mr.sender_id, mr.envelope_json, mr.room_id, mr.topic, mr.topic_id, mr.state, mr.created_at
    FROM message_records mr
    INNER JOIN (
      SELECT msg_id, MIN(id) AS min_id
      FROM message_records
      WHERE room_id = ${roomId}
      GROUP BY msg_id
    ) dedup ON mr.id = dedup.min_id
    WHERE mr.room_id = ${roomId}
    ${cursorCondition}
    ORDER BY mr.id DESC
    LIMIT ${limit + 1}
  `);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const messages = pageRows.map((row) => {
    let text = "";
    let senderId = row.sender_id;
    let payload: Record<string, unknown> = {};
    let type = "message";
    try {
      const envelope = JSON.parse(row.envelope_json) as Record<string, unknown>;
      const extracted = extractTextFromEnvelope(envelope);
      text = extracted.text;
      if (extracted.senderId) senderId = extracted.senderId;
      type = typeof envelope.type === "string" ? envelope.type : "message";
      payload = extracted.payload;
    } catch {
      // ignore
    }
    return {
      hub_msg_id: row.hub_msg_id,
      msg_id: row.msg_id,
      sender_id: senderId,
      sender_name: senderId,
      type,
      text,
      payload,
      room_id: row.room_id,
      topic: row.topic,
      topic_id: row.topic_id,
      goal: null,
      state: row.state,
      state_counts: null,
      created_at: row.created_at,
    };
  });

  return NextResponse.json({
    messages,
    has_more: hasMore,
  });
}
