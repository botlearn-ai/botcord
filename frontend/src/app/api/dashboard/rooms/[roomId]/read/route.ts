/**
 * [INPUT]: 依赖 requireAgent 识别当前 active agent，依赖 backendDb + roomMembers 持久化房间阅读水位
 * [OUTPUT]: 对外提供 POST /api/dashboard/rooms/[roomId]/read，写入当前成员在该房间的 last_viewed_at
 * [POS]: dashboard 房间阅读语义写入口，被消息列表在用户看到最新位置时调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { backendDb } from "@/../db/backend";
import { roomMembers } from "@/../db/schema";
import { requireAgent } from "@/lib/require-agent";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const auth = await requireAgent();
  if (auth.error) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }

  const { roomId } = await params;
  const [membership] = await backendDb
    .update(roomMembers)
    .set({ lastViewedAt: sql`now()` })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, auth.agentId)))
    .returning({
      roomId: roomMembers.roomId,
      lastViewedAt: roomMembers.lastViewedAt,
    });

  if (!membership) {
    return NextResponse.json({ error: "Not a member of this room" }, { status: 403 });
  }

  return NextResponse.json({
    room_id: membership.roomId,
    last_viewed_at: membership.lastViewedAt?.toISOString() ?? null,
  });
}
