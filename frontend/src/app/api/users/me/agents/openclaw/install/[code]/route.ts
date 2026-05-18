/**
 * [INPUT]: Supabase user session, OpenClaw install bind code path param
 * [OUTPUT]: GET status / DELETE revoke for an OpenClaw install code
 * [POS]: BFF endpoint backing OpenClaw install-code polling after legacy generic bind-ticket routes were removed
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyDaemon } from "../../../../../../daemon/_lib/proxy";

interface Ctx {
  params: Promise<{ code: string }>;
}

export async function GET(_req: Request, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  return proxyDaemon(`/api/users/me/agents/openclaw/install/${encodeURIComponent(code)}`, {
    method: "GET",
  });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<NextResponse> {
  const { code } = await ctx.params;
  return proxyDaemon(`/api/users/me/agents/openclaw/install/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
}
