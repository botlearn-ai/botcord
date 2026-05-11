/**
 * [INPUT]: Supabase user session, daemon instance id from path
 * [OUTPUT]: POST /api/daemon/instances/[id]/diagnostics — asks Hub to collect daemon diagnostics
 * [POS]: BFF endpoint backing Dashboard daemon diagnostics upload button
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
    `/daemon/instances/${encodeURIComponent(id)}/diagnostics`,
    { method: "POST" },
  );
}
