/**
 * [INPUT]: Supabase server client for forwarding bearer token
 * [OUTPUT]: proxyHub — forwards an arbitrary path to the backend Hub, preserving
 *          status code and JSON/empty bodies; sibling of daemon/_lib/proxy.ts
 *          but supports the full set of HTTP verbs used by /api/agents/* routes.
 * [POS]: shared BFF helper for non-daemon Hub-backed routes
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:8000"
    : "https://api.botcord.chat");

export type HubMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function getSupabaseAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function proxyHub(
  path: string,
  init: { method: HubMethod; body?: unknown },
): Promise<NextResponse> {
  const token = await getSupabaseAccessToken();
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  const url = new URL(path, HUB_BASE_URL).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers,
      body,
      cache: "no-store",
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "upstream_unreachable",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  if (res.status === 204) {
    return new NextResponse(null, { status: 204 });
  }

  const text = await res.text();
  if (!text) {
    return new NextResponse(null, { status: res.status });
  }
  try {
    const json = JSON.parse(text);
    return NextResponse.json(json, { status: res.status });
  } catch {
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") || "text/plain" },
    });
  }
}
