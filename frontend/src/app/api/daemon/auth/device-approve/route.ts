/**
 * [INPUT]: Supabase user session, JSON { user_code, label? }
 * [OUTPUT]: POST /api/daemon/auth/device-approve — proxies to Hub /daemon/auth/device-approve
 * [POS]: BFF endpoint for the P1 device-code "Authorize this device" flow on /activate
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyDaemon } from "../../_lib/proxy";

export async function POST(req: Request) {
  let body: { user_code?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const userCode = (body.user_code ?? "").toString().trim().toUpperCase();
  if (!userCode) {
    return NextResponse.json({ error: "user_code_required" }, { status: 400 });
  }
  const payload: { user_code: string; label?: string } = { user_code: userCode };
  if (typeof body.label === "string" && body.label.trim()) {
    payload.label = body.label.trim();
  }
  return proxyDaemon("/daemon/auth/device-approve", {
    method: "POST",
    body: payload,
  });
}
