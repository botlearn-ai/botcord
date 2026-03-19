/**
 * [INPUT]: 依赖 requireAuth/requireAgent 区分登录态与 active agent，依赖 _room-messages 统一构造成员/公开消息响应
 * [OUTPUT]: 对外提供 GET /api/dashboard/rooms/[roomId]/messages；有 active agent 时返回成员视角消息，无 active agent 且房间公开时回退到公开消息视角
 * [POS]: dashboard 消息 BFF，在 agent 专属会话与登录后的公开浏览之间提供统一入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import { requireAuth } from "@/lib/auth";
import { loadMemberRoomMessagesResponse, loadPublicRoomMessagesResponse } from "@/app/api/_room-messages";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;
  const session = await requireAuth();
  if (session.error) {
    return NextResponse.json({ error: session.error.message }, { status: session.error.status });
  }

  const { searchParams } = request.nextUrl;
  const before = searchParams.get("before");
  const after = searchParams.get("after");
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "50", 10), 1), 100);

  const auth = await requireAgent();
  if (auth.error) {
    if (auth.error.status === 400) {
      return loadPublicRoomMessagesResponse(roomId, { before, limit });
    }
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  return loadMemberRoomMessagesResponse(roomId, auth.agentId, {
    before,
    after,
    limit,
  });
}
