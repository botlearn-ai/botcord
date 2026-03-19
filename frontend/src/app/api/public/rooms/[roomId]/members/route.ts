import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { rooms, roomMembers, agents } from "@/../db/schema";
import { eq } from "drizzle-orm";

/**
 * [INPUT]: 依赖 backendDb 与 rooms/roomMembers/agents 表读取公开房间成员及 agent 公开资料
 * [OUTPUT]: 对外提供公开房间成员列表（含简介与消息策略）JSON 响应
 * [POS]: public rooms members BFF 路由，为前端右侧成员列表与 agent 卡片提供单次数据源
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;

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

  const members = await backendDb
    .select({
      agentId: roomMembers.agentId,
      role: roomMembers.role,
      joinedAt: roomMembers.joinedAt,
      displayName: agents.displayName,
      bio: agents.bio,
      messagePolicy: agents.messagePolicy,
      createdAt: agents.createdAt,
    })
    .from(roomMembers)
    .innerJoin(agents, eq(roomMembers.agentId, agents.agentId))
    .where(eq(roomMembers.roomId, roomId));

  return NextResponse.json({
    room_id: roomId,
    members: members.map((m) => ({
      agent_id: m.agentId,
      display_name: m.displayName,
      bio: m.bio,
      message_policy: m.messagePolicy,
      created_at: m.createdAt.toISOString(),
      role: m.role,
      joined_at: m.joinedAt.toISOString(),
    })),
    total: members.length,
  });
}
