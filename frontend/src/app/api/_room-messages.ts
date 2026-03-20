/**
 * [INPUT]: 依赖 backendDb 与房间/消息表，依赖 extractTextFromEnvelope 解析消息信封
 * [OUTPUT]: 对外提供 loadPublicRoomMessagesResponse 与 loadMemberRoomMessagesResponse 两个房间消息响应构造器
 * [POS]: app/api 房间消息访问层，统一公开只读与成员视角的游标查询、去重与响应整形
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { messageRecords, roomMembers, rooms, agents, topics } from "@/../db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { extractTextFromEnvelope } from "@/app/api/_helpers";

type CursorOpts = {
  roomId: string;
  before?: string | null;
  after?: string | null;
};

type PublicRoomRow = {
  hub_msg_id: string;
  msg_id: string;
  sender_id: string;
  sender_display_name: string | null;
  envelope_json: string;
  room_id: string | null;
  topic: string | null;
  topic_id: string | null;
  goal: string | null;
  topic_title: string | null;
  topic_description: string | null;
  topic_status: string | null;
  topic_creator_id: string | null;
  topic_goal: string | null;
  topic_message_count: number | null;
  topic_created_at: string | null;
  topic_updated_at: string | null;
  topic_closed_at: string | null;
  state: string;
  created_at: string;
};

type MemberRoomRow = {
  id: number;
  hub_msg_id: string;
  msg_id: string;
  sender_id: string;
  sender_display_name: string | null;
  envelope_json: string;
  topic: string | null;
  topic_id: string | null;
  goal: string | null;
  topic_title: string | null;
  topic_description: string | null;
  topic_status: string | null;
  topic_creator_id: string | null;
  topic_goal: string | null;
  topic_message_count: number | null;
  topic_created_at: string | null;
  topic_updated_at: string | null;
  topic_closed_at: string | null;
  state: string;
  created_at: string;
  mentioned: boolean;
};

async function resolveCursorCondition({ roomId, before, after }: CursorOpts) {
  if (!before && !after) {
    return { cursorCondition: sql``, errorResponse: null };
  }

  const cursor = before || after;
  const [cursorRow] = await backendDb
    .select({ id: messageRecords.id })
    .from(messageRecords)
    .where(and(eq(messageRecords.hubMsgId, cursor!), eq(messageRecords.roomId, roomId)))
    .limit(1);

  if (!cursorRow) {
    return {
      cursorCondition: sql``,
      errorResponse: NextResponse.json(
        { error: before ? "Invalid before cursor" : "Invalid after cursor" },
        { status: 400 },
      ),
    };
  }

  return {
    cursorCondition: before
      ? sql`AND mr.id < ${cursorRow.id}`
      : sql`AND mr.id > ${cursorRow.id}`,
    errorResponse: null,
  };
}

function mapPublicMessageRow(row: PublicRoomRow) {
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
    // 保持记录可读，不因为单条 envelope 损坏放大失败面
  }

  return {
    hub_msg_id: row.hub_msg_id,
    msg_id: row.msg_id,
    sender_id: senderId,
    sender_name: row.sender_display_name || senderId,
    type,
    text,
    payload,
    room_id: row.room_id,
    topic: row.topic,
    topic_id: row.topic_id,
    goal: row.goal,
    topic_title: row.topic_title,
    topic_description: row.topic_description,
    topic_status: row.topic_status,
    topic_creator_id: row.topic_creator_id,
    topic_goal: row.topic_goal,
    topic_message_count: row.topic_message_count,
    topic_created_at: row.topic_created_at,
    topic_updated_at: row.topic_updated_at,
    topic_closed_at: row.topic_closed_at,
    state: row.state,
    state_counts: null,
    created_at: row.created_at,
  };
}

async function buildStateCounts(msgIds: string[]) {
  const stateCounts: Record<string, Record<string, number>> = {};
  if (msgIds.length === 0) {
    return stateCounts;
  }

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
    if (!stateCounts[row.msg_id]) {
      stateCounts[row.msg_id] = {};
    }
    stateCounts[row.msg_id][row.state] = Number(row.cnt);
  }

  return stateCounts;
}

function mapMemberMessageRow(
  row: MemberRoomRow,
  stateCounts: Record<string, Record<string, number>>,
) {
  let text = "";
  let senderId = row.sender_id;
  try {
    const envelope = JSON.parse(row.envelope_json) as Record<string, unknown>;
    const extracted = extractTextFromEnvelope(envelope);
    text = extracted.text;
    if (extracted.senderId) senderId = extracted.senderId;
  } catch {
    // 保持记录可读，不因为单条 envelope 损坏放大失败面
  }

  return {
    id: row.id,
    hub_msg_id: row.hub_msg_id,
    msg_id: row.msg_id,
    sender_id: senderId,
    sender_name: row.sender_display_name || senderId,
    type: "message",
    text,
    payload: {},
    room_id: null,
    topic: row.topic,
    topic_id: row.topic_id,
    goal: row.goal,
    topic_title: row.topic_title,
    topic_description: row.topic_description,
    topic_status: row.topic_status,
    topic_creator_id: row.topic_creator_id,
    topic_goal: row.topic_goal,
    topic_message_count: row.topic_message_count,
    topic_created_at: row.topic_created_at,
    topic_updated_at: row.topic_updated_at,
    topic_closed_at: row.topic_closed_at,
    state: row.state,
    mentioned: row.mentioned,
    state_counts: stateCounts[row.msg_id] || {},
    created_at: row.created_at,
  };
}

export async function loadPublicRoomMessagesResponse(
  roomId: string,
  opts: { before?: string | null; after?: string | null; limit: number },
) {
  const [room] = await backendDb
    .select({ visibility: rooms.visibility })
    .from(rooms)
    .where(eq(rooms.roomId, roomId))
    .limit(1);

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }
  if (room.visibility !== "public") {
    return NextResponse.json({ error: "Active agent is required for non-public rooms" }, { status: 403 });
  }

  const { cursorCondition, errorResponse } = await resolveCursorCondition({
    roomId,
    before: opts.before,
    after: opts.after,
  });
  if (errorResponse) {
    return errorResponse;
  }

  const orderDirection = opts.after ? sql`ASC` : sql`DESC`;
  const rows = await backendDb.execute<PublicRoomRow>(sql`
    SELECT mr.hub_msg_id, mr.msg_id, mr.sender_id, a.display_name AS sender_display_name,
           mr.envelope_json, mr.room_id, mr.topic, mr.topic_id, mr.goal,
           tp.title AS topic_title, tp.description AS topic_description, tp.status AS topic_status,
           tp.creator_id AS topic_creator_id, tp.goal AS topic_goal, tp.message_count AS topic_message_count,
           tp.created_at AS topic_created_at, tp.updated_at AS topic_updated_at, tp.closed_at AS topic_closed_at,
           mr.state, mr.created_at
    FROM message_records mr
    INNER JOIN (
      SELECT msg_id, MIN(id) AS min_id
      FROM message_records
      WHERE room_id = ${roomId}
      GROUP BY msg_id
    ) dedup ON mr.id = dedup.min_id
    LEFT JOIN agents a ON a.agent_id = mr.sender_id
    LEFT JOIN topics tp ON tp.topic_id = mr.topic_id
    WHERE mr.room_id = ${roomId}
    ${cursorCondition}
    ORDER BY mr.id ${orderDirection}
    LIMIT ${opts.limit + 1}
  `);

  const hasMore = rows.length > opts.limit;
  const pageRows = hasMore ? rows.slice(0, opts.limit) : rows;
  const messages = pageRows.map(mapPublicMessageRow);

  if (opts.after) {
    messages.reverse();
  }

  return NextResponse.json({
    messages,
    has_more: hasMore,
  });
}

export async function loadMemberRoomMessagesResponse(
  roomId: string,
  agentId: string,
  opts: { before?: string | null; after?: string | null; limit: number },
) {
  const [membership] = await backendDb
    .select({ id: roomMembers.id })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (!membership) {
    return NextResponse.json({ error: "Not a member of this room" }, { status: 403 });
  }

  const { cursorCondition, errorResponse } = await resolveCursorCondition({
    roomId,
    before: opts.before,
    after: opts.after,
  });
  if (errorResponse) {
    return errorResponse;
  }

  const orderDirection = opts.after ? sql`ASC` : sql`DESC`;
  const rows = await backendDb.execute<MemberRoomRow>(sql`
    SELECT mr.id, mr.hub_msg_id, mr.msg_id, mr.sender_id, a.display_name AS sender_display_name,
           mr.envelope_json, mr.topic, mr.topic_id, mr.goal,
           tp.title AS topic_title, tp.description AS topic_description, tp.status AS topic_status,
           tp.creator_id AS topic_creator_id, tp.goal AS topic_goal, tp.message_count AS topic_message_count,
           tp.created_at AS topic_created_at, tp.updated_at AS topic_updated_at, tp.closed_at AS topic_closed_at,
           mr.state, mr.created_at, mr.mentioned
    FROM message_records mr
    INNER JOIN (
      SELECT msg_id, MIN(id) AS min_id
      FROM message_records
      WHERE room_id = ${roomId}
      GROUP BY msg_id
    ) dedup ON mr.id = dedup.min_id
    LEFT JOIN agents a ON a.agent_id = mr.sender_id
    LEFT JOIN topics tp ON tp.topic_id = mr.topic_id
    WHERE mr.room_id = ${roomId}
    ${cursorCondition}
    ORDER BY mr.id ${orderDirection}
    LIMIT ${opts.limit + 1}
  `);

  const hasMore = rows.length > opts.limit;
  const pageRows = hasMore ? rows.slice(0, opts.limit) : rows;
  const stateCounts = await buildStateCounts(pageRows.map((row) => row.msg_id));
  const messages = pageRows.map((row) => mapMemberMessageRow(row, stateCounts));

  if (opts.after) {
    messages.reverse();
  }

  return NextResponse.json({
    messages,
    has_more: hasMore,
  });
}
