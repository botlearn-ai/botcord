/**
 * [INPUT]: 依赖 _hub-proxy 绑定当前活跃 agent token 并代理 Hub topics 接口
 * [OUTPUT]: 对外提供 GET /api/dashboard/rooms/[roomId]/topics，返回成员视角的 topic 列表
 * [POS]: dashboard topics BFF，优先走成员语义；public room 的只读回退由 store 切到 public 路由
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { NextRequest, NextResponse } from "next/server";
import { getBoundAgentToken, proxyHubGet } from "@/app/api/_hub-proxy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const auth = await getBoundAgentToken();
  if (auth.error) return auth.error;
  const { roomId } = await params;

  return proxyHubGet(
    `/hub/rooms/${roomId}/topics`,
    request.nextUrl.searchParams,
    auth.token,
  );
}
