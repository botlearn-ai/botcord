/**
 * [INPUT]: Supabase user session, optional patch body {label?}
 * [OUTPUT]: PATCH /rename, DELETE /revoke for a single OpenClaw host instance
 * [POS]: BFF endpoint for managing registered OpenClaw hosts
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyDaemon } from "../../../../../../daemon/_lib/proxy";

interface Ctx {
  params: Promise<{ hostId: string }>;
}

export async function PATCH(req: Request, ctx: Ctx): Promise<NextResponse> {
  const { hostId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return proxyDaemon(`/api/users/me/agents/openclaw/hosts/${hostId}`, {
    method: "PATCH",
    body,
  });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<NextResponse> {
  const { hostId } = await ctx.params;
  return proxyDaemon(`/api/users/me/agents/openclaw/hosts/${hostId}`, {
    method: "DELETE",
  });
}
