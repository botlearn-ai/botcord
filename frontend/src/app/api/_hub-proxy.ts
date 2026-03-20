import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import { createClient } from "@/lib/supabase/server";

const API_BASE =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "https://api.botcord.chat");

export async function getBoundAgentToken(): Promise<
  | { token: string; agentId: string; error: null }
  | { token: null; agentId: null; error: NextResponse }
> {
  const auth = await requireAgent();
  if (auth.error) {
    return {
      token: null,
      agentId: null,
      error: NextResponse.json(
        { error: auth.error.message },
        { status: auth.error.status },
      ),
    };
  }

  // Use the Supabase access token (auto-refreshed by middleware) instead of
  // the stored Hub agent JWT which can expire after 24h.
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    return {
      token: null,
      agentId: null,
      error: NextResponse.json(
        { error: "Supabase session not found" },
        { status: 401 },
      ),
    };
  }

  return { token: session.access_token, agentId: auth.agentId, error: null };
}

export async function proxyHubGet(
  hubPath: string,
  query: URLSearchParams,
  token: string,
  agentId?: string,
): Promise<NextResponse> {
  const upstreamUrl = new URL(hubPath, API_BASE);
  query.forEach((value, key) => upstreamUrl.searchParams.set(key, value));

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (agentId) {
    headers["X-Active-Agent"] = agentId;
  }

  const upstream = await fetch(upstreamUrl.toString(), {
    method: "GET",
    headers,
    cache: "no-store",
  });

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
  });
}
