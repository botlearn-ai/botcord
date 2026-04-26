/**
 * [INPUT]: Supabase server client for forwarding bearer token
 * [OUTPUT]: Helpers that proxy a request to the backend Hub /daemon/* endpoints
 * [POS]: BFF helper for daemon control-plane routes
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:8000"
    : "https://api.botcord.chat");

export async function getSupabaseAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function proxyDaemon(
  path: string,
  init: { method: "GET" | "POST" | "DELETE" | "PATCH"; body?: unknown },
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

  const text = await res.text();
  if (!text) {
    return new NextResponse(null, { status: res.status });
  }
  // Try to forward as JSON; fall back to plain text
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
