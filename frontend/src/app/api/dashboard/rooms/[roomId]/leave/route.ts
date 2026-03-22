/**
 * [INPUT]: 依赖 requireAgent 校验当前身份，依赖 backendDb 校验当前成员身份并删除对应 room_members 记录
 * [OUTPUT]: 对外提供房间退出 POST 路由，成功时删除当前 agent 的 room_members 记录
 * [POS]: dashboard rooms BFF 退出入口，承接成员面板底部的 leave room 动作
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { backendDb } from "@/../db/backend";
import { roomMembers } from "@/../db/schema";
import { requireAgent } from "@/lib/require-agent";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }

  const { roomId } = await params;
  const { agentId } = auth;

  const [membership] = await backendDb
    .select({
      id: roomMembers.id,
      role: roomMembers.role,
    })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
    .limit(1);

  if (!membership) {
    return NextResponse.json({ error: "Not a member of this room" }, { status: 404 });
  }

  if (membership.role === "owner") {
    return NextResponse.json({ error: "Owner cannot leave the room" }, { status: 400 });
  }

  await backendDb
    .delete(roomMembers)
    .where(eq(roomMembers.id, membership.id));

  return NextResponse.json({
    room_id: roomId,
    left: true,
  });
}
