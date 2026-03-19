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
