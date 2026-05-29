/**
 * [INPUT]: grantId from path; Supabase session via proxyHub
 * [OUTPUT]: DELETE /api/agent-management/grants/[grantId] — revokes a grant via Hub
 * [POS]: BFF endpoint for future settings grant-management actions
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyHub } from "../../../_lib/proxy-hub";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ grantId: string }> },
) {
  const { grantId } = await params;
  if (!grantId) {
    return NextResponse.json({ error: "missing_grant_id" }, { status: 400 });
  }
  return proxyHub(`/api/agent-management/grants/${encodeURIComponent(grantId)}`, {
    method: "DELETE",
  });
}
