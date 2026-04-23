/**
 * [INPUT]: Supabase user session, daemon instance id from path
 * [OUTPUT]: POST /api/daemon/instances/[id]/revoke — revoke a daemon instance
 * [POS]: BFF endpoint for the per-row revoke action on /settings/daemons
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyDaemon } from "../../../_lib/proxy";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  return proxyDaemon(
    `/daemon/instances/${encodeURIComponent(id)}/revoke`,
    { method: "POST" },
  );
}
