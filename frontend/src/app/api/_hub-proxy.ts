import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import { db } from "@/../db";
import { userAgents } from "@/../db/schema";
import { and, eq } from "drizzle-orm";

const HUB_API_BASE =
  process.env.HUB_API_BASE ||
  process.env.NEXT_PUBLIC_API_BASE ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "https://api.botcord.chat");

export async function getBoundAgentToken(): Promise<
  | { token: string; error: null }
  | { token: null; error: NextResponse }
> {
  const auth = await requireAgent();
  if (auth.error) {
    return {
      token: null,
      error: NextResponse.json(
        { error: auth.error.message },
        { status: auth.error.status },
      ),
    };
  }

  const [boundAgent] = await db
    .select({ agentToken: userAgents.agentToken })
    .from(userAgents)
    .where(and(eq(userAgents.userId, auth.userId), eq(userAgents.agentId, auth.agentId)))
    .limit(1);

  if (!boundAgent?.agentToken) {
    return {
      token: null,
      error: NextResponse.json(
        { error: "Active agent token not found" },
        { status: 404 },
      ),
    };
  }

  return { token: boundAgent.agentToken, error: null };
}

export async function proxyHubGet(
  hubPath: string,
  query: URLSearchParams,
  agentToken: string,
): Promise<NextResponse> {
  const upstreamUrl = new URL(hubPath, HUB_API_BASE);
  query.forEach((value, key) => upstreamUrl.searchParams.set(key, value));

  const upstream = await fetch(upstreamUrl.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${agentToken}` },
    cache: "no-store",
  });

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
  });
}

