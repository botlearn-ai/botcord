/**
 * [INPUT]: Supabase user session, daemon instance id from path
 * [OUTPUT]: POST /api/daemon/instances/[id]/restart — restart/update a daemon instance
 * [POS]: BFF endpoint for Dashboard device restart actions
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
    `/daemon/instances/${encodeURIComponent(id)}/restart`,
    { method: "POST" },
  );
}
