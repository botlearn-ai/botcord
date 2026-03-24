/**
 * [INPUT]: 依赖 requireAgent 校验当前身份，依赖 backendDb 校验公开房间规则、人数上限与订阅资格
 * [OUTPUT]: 对外提供房间加入 POST 路由，成功时创建 room_members 记录
 * [POS]: dashboard rooms BFF 写入口，承接 explore/public 视图中的加入动作
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { NextRequest, NextResponse } from "next/server";
import { backendDb } from "@/../db/backend";
import { rooms, roomMembers, agents, agentSubscriptions } from "@/../db/schema";
import { eq, and, count } from "drizzle-orm";
import { requireAgent } from "@/lib/require-agent";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  const { agentId } = auth;
  const { roomId } = await params;

  // Ensure active agent exists in backend DB (prevents FK 500 on insert)
  const [backendAgent] = await backendDb
    .select({ agentId: agents.agentId })
    .from(agents)
    .where(eq(agents.agentId, agentId))
    .limit(1);

  if (!backendAgent) {
    return NextResponse.json(
      { error: "Active agent not found in backend registry" },
      { status: 404 },
    );
  }

  // Get room
  const [room] = await backendDb
    .select({
      roomId: rooms.roomId,
      visibility: rooms.visibility,
      joinPolicy: rooms.joinPolicy,
      maxMembers: rooms.maxMembers,
      defaultSend: rooms.defaultSend,
      defaultInvite: rooms.defaultInvite,
      requiredSubscriptionProductId: rooms.requiredSubscriptionProductId,
    })
    .from(rooms)
    .where(eq(rooms.roomId, roomId))
    .limit(1);

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  // Check subscription access first — active subscribers bypass visibility/joinPolicy
  let hasSubscriptionAccess = false;
  if (room.requiredSubscriptionProductId) {
    const [subscription] = await backendDb
      .select({ id: agentSubscriptions.id })
      .from(agentSubscriptions)
      .where(
        and(
          eq(agentSubscriptions.productId, room.requiredSubscriptionProductId),
          eq(agentSubscriptions.subscriberAgentId, agentId),
          eq(agentSubscriptions.status, "active"),
        ),
      )
      .limit(1);

    if (subscription) {
      hasSubscriptionAccess = true;
    } else {
      return NextResponse.json(
        { error: "Active subscription required before joining this room" },
        { status: 403 },
      );
    }
  }

  if (!hasSubscriptionAccess) {
    if (room.visibility !== "public") {
      return NextResponse.json({ error: "Room is not public" }, { status: 403 });
    }

    if (room.joinPolicy !== "open") {
      return NextResponse.json({ error: "Room does not allow open join" }, { status: 403 });
    }
  }

  // Check if already a member
  const [existing] = await backendDb
    .select({ id: roomMembers.id })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (existing) {
    // Backend auto-join may have already added the member during subscription;
    // treat as success so the frontend flow completes cleanly.
    return NextResponse.json({
      room_id: roomId,
      agent_id: agentId,
      role: "member",
      joined: true,
      already_member: true,
    });
  }

  // Check max_members
  if (room.maxMembers !== null) {
    const [memberCount] = await backendDb
      .select({ count: count() })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, roomId));

    if (memberCount.count >= room.maxMembers) {
      return NextResponse.json({ error: "Room is full" }, { status: 403 });
    }
  }

  // Join room
  try {
    await backendDb.insert(roomMembers).values({
      roomId,
      agentId,
      role: "member",
      muted: false,
      canSend: room.defaultSend,
      canInvite: room.defaultInvite,
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      return NextResponse.json({ error: "Already a member of this room" }, { status: 409 });
    }
    if (code === "23503") {
      return NextResponse.json({ error: "Invalid room or agent reference" }, { status: 400 });
    }
    throw err;
  }

  return NextResponse.json({
    room_id: roomId,
    agent_id: agentId,
    role: "member",
    joined: true,
  });
}
