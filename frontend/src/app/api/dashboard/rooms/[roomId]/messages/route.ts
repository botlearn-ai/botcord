import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { roomMembers, messageRecords } from "@/../db/backend-schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";
import { extractTextFromEnvelope } from "@/app/api/_helpers";

export async function GET(
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

  const { searchParams } = request.nextUrl;
  const before = searchParams.get("before");
  const after = searchParams.get("after");
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "50", 10), 1), 100);

  // Build cursor condition (cursor uses hub_msg_id, not numeric row id)
  let cursorCondition = sql``;
  if (before) {
    const [cursorRow] = await backendDb
      .select({ id: messageRecords.id })
      .from(messageRecords)
      .where(and(eq(messageRecords.hubMsgId, before), eq(messageRecords.roomId, roomId)))
      .limit(1);
    if (!cursorRow) {
      return NextResponse.json({ error: "Invalid before cursor" }, { status: 400 });
    }
    cursorCondition = sql`AND mr.id < ${cursorRow.id}`;
  } else if (after) {
    const [cursorRow] = await backendDb
      .select({ id: messageRecords.id })
      .from(messageRecords)
      .where(and(eq(messageRecords.hubMsgId, after), eq(messageRecords.roomId, roomId)))
      .limit(1);
    if (!cursorRow) {
      return NextResponse.json({ error: "Invalid after cursor" }, { status: 400 });
    }
    cursorCondition = sql`AND mr.id > ${cursorRow.id}`;
  }

  const orderDirection = after ? sql`ASC` : sql`DESC`;

  // Dedup fan-out and fetch messages
  const rows = await backendDb.execute<{
    id: number;
    hub_msg_id: string;
    msg_id: string;
    sender_id: string;
    envelope_json: string;
    state: string;
    created_at: string;
    mentioned: boolean;
  }>(sql`
    SELECT mr.id, mr.hub_msg_id, mr.msg_id, mr.sender_id, mr.envelope_json,
           mr.state, mr.created_at, mr.mentioned
    FROM message_records mr
    INNER JOIN (
      SELECT msg_id, MIN(id) AS min_id
      FROM message_records
      WHERE room_id = ${roomId}
      GROUP BY msg_id
    ) dedup ON mr.id = dedup.min_id
    WHERE mr.room_id = ${roomId}
    ${cursorCondition}
    ORDER BY mr.id ${orderDirection}
    LIMIT ${limit + 1}
  `);

  // Get state counts per message
  const msgIds = rows.map((r) => r.msg_id);

  let stateCounts: Record<string, Record<string, number>> = {};
  if (msgIds.length > 0) {
    const stateRows = await backendDb
      .select({
        msg_id: messageRecords.msgId,
        state: messageRecords.state,
        cnt: sql<number>`count(*)`,
      })
      .from(messageRecords)
      .where(inArray(messageRecords.msgId, msgIds))
      .groupBy(messageRecords.msgId, messageRecords.state);

    for (const row of stateRows) {
      if (!stateCounts[row.msg_id]) stateCounts[row.msg_id] = {};
      stateCounts[row.msg_id][row.state] = Number(row.cnt);
    }
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const messages = pageRows.map((row) => {
    let text = "";
    let senderId = row.sender_id;
    try {
      const envelope = JSON.parse(row.envelope_json) as Record<string, unknown>;
      const extracted = extractTextFromEnvelope(envelope);
      text = extracted.text;
      if (extracted.senderId) senderId = extracted.senderId;
    } catch {
      // ignore
    }
    return {
      id: row.id,
      hub_msg_id: row.hub_msg_id,
      msg_id: row.msg_id,
      sender_id: senderId,
      text,
      state: row.state,
      mentioned: row.mentioned,
      created_at: row.created_at,
      state_counts: stateCounts[row.msg_id] || {},
    };
  });

  // If we used "after" ordering, reverse to maintain DESC order
  if (after) {
    messages.reverse();
  }

  return NextResponse.json({
    messages,
    has_more: hasMore,
  });
}
