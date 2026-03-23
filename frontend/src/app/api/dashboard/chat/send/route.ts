import { NextRequest, NextResponse } from "next/server";
import { getBoundAgentToken } from "@/app/api/_hub-proxy";

const API_BASE =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "https://api.botcord.chat");

export async function POST(req: NextRequest) {
  const bound = await getBoundAgentToken();
  if (bound.error) return bound.error;

  const body = await req.json();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${bound.token}`,
  };
  if (bound.agentId) {
    headers["X-Active-Agent"] = bound.agentId;
  }

  const upstream = await fetch(`${API_BASE}/dashboard/chat/send`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") || "application/json" },
  });
}
