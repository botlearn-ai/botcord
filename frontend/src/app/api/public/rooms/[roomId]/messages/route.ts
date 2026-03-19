/**
 * [INPUT]: 依赖 _room-messages 统一构造公开房间消息响应
 * [OUTPUT]: 对外提供 GET /api/public/rooms/[roomId]/messages，返回公开房间的只读消息分页
 * [POS]: public rooms 消息 BFF，复用 app/api 共享的消息读取能力
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { NextRequest, NextResponse } from "next/server";
import { loadPublicRoomMessagesResponse } from "@/app/api/_room-messages";

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
  return loadPublicRoomMessagesResponse(roomId, { before: effectiveBefore, limit });
}
