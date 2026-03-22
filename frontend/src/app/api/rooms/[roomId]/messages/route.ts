/**
 * [INPUT]: 依赖 Supabase cookie-session 与 X-Active-Agent，依赖 _room-messages 统一处理 member/public 权限判定与响应整形
 * [OUTPUT]: 对外提供 GET /api/rooms/[roomId]/messages，返回单一协议的房间消息分页响应
 * [POS]: app/api 的统一房间消息 BFF，屏蔽 guest/public/member viewer 的路由分叉
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db } from "@/../db";
import { agents } from "@/../db/schema";
import { getAuthUser } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { loadRoomMessagesResponse } from "@/app/api/_room-messages";

async function resolveViewerAgentId(): Promise<
  | { agentId: string | null; error: null }
  | { agentId: null; error: { status: number; message: string } }
> {
  const user = await getAuthUser();
  if (!user) {
    return { agentId: null, error: null };
  }

  const headerStore = await headers();
  const activeAgentId = headerStore.get("x-active-agent");
  if (!activeAgentId) {
    return { agentId: null, error: null };
  }

  const [agent] = await db
    .select({ agentId: agents.agentId })
    .from(agents)
    .where(and(eq(agents.userId, user.id), eq(agents.agentId, activeAgentId)))
    .limit(1);

  if (!agent) {
    return {
      agentId: null,
      error: { status: 403, message: "Agent does not belong to this user" },
    };
  }

  return { agentId: agent.agentId, error: null };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;
  const { searchParams } = request.nextUrl;
  const before = searchParams.get("before");
  const cursor = searchParams.get("cursor");
  const after = searchParams.get("after");
  const effectiveBefore = before || cursor;
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "50", 10), 1), 100);

  const viewer = await resolveViewerAgentId();
  if (viewer.error) {
    return NextResponse.json({ error: viewer.error.message }, { status: viewer.error.status });
  }

  return loadRoomMessagesResponse(
    roomId,
    { agentId: viewer.agentId },
    { before: effectiveBefore, after, limit },
  );
}
