/**
 * [INPUT]: Supabase user session, daemon instance id from path, JSON body { label }
 * [OUTPUT]: PATCH /api/daemon/instances/[id] — update daemon label
 * [POS]: BFF endpoint for the per-row rename action on /settings/daemons
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyDaemon } from "../../_lib/proxy";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return proxyDaemon(`/daemon/instances/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}
