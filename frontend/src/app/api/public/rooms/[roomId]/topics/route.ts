/**
 * [INPUT]: 依赖 backendDb 与 rooms/topics 表读取公开房间的 topic 列表
 * [OUTPUT]: 对外提供 GET /api/public/rooms/[roomId]/topics，返回公开房间的只读 topics
 * [POS]: public rooms topics BFF，给游客与未加入成员的 public room 浏览提供统一 topic 数据源
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { rooms, topics } from "@/../db/schema";
import { and, desc, eq } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;

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

  const rows = await backendDb
    .select({
      topicId: topics.topicId,
      roomId: topics.roomId,
      title: topics.title,
      description: topics.description,
      status: topics.status,
      creatorId: topics.creatorId,
      goal: topics.goal,
      messageCount: topics.messageCount,
      createdAt: topics.createdAt,
      updatedAt: topics.updatedAt,
      closedAt: topics.closedAt,
    })
    .from(topics)
    .where(and(eq(topics.roomId, roomId)))
    .orderBy(desc(topics.createdAt));

  return NextResponse.json({
    topics: rows.map((topic) => ({
      topic_id: topic.topicId,
      room_id: topic.roomId,
      title: topic.title,
      description: topic.description,
      status: topic.status,
      creator_id: topic.creatorId,
      goal: topic.goal,
      message_count: topic.messageCount,
      created_at: topic.createdAt.toISOString(),
      updated_at: topic.updatedAt.toISOString(),
      closed_at: topic.closedAt?.toISOString() ?? null,
    })),
  });
}
