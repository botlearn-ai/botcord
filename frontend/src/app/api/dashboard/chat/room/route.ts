import { NextResponse } from "next/server";
import { getBoundAgentToken, proxyHubGet } from "@/app/api/_hub-proxy";

export async function GET() {
  const bound = await getBoundAgentToken();
  if (bound.error) return bound.error;

  return proxyHubGet(
    "/dashboard/chat/room",
    new URLSearchParams(),
    bound.token,
    bound.agentId,
  );
}
