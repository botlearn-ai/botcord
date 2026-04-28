/**
 * [INPUT]: Supabase user session, optional JSON { label }
 * [OUTPUT]: POST /api/daemon/auth/install-ticket — proxies to Hub /daemon/auth/install-ticket
 * [POS]: BFF endpoint for non-interactive daemon install command generation
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyDaemon } from "../../_lib/proxy";

export async function POST(req: Request) {
  let body: { label?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const payload: { label?: string } = {};
  if (typeof body.label === "string" && body.label.trim()) {
    payload.label = body.label.trim();
  }
  return proxyDaemon("/daemon/auth/install-ticket", {
    method: "POST",
    body: payload,
  });
}
