/**
 * [INPUT]: Supabase user session, daemon instance id from path, optional body
 *          { forget_if_offline?: boolean, reason?: string }
 * [OUTPUT]: POST /api/daemon/instances/[id]/remove — detach hosted bots and
 *           queue local cleanup; revoke immediately when forget_if_offline.
 * [POS]: BFF endpoint for the My Bots / Settings Remove Device action
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { proxyDaemon } from "../../../_lib/proxy";

type RemoveBody = {
  forget_if_offline?: boolean;
  reason?: string;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  let body: RemoveBody = {};
  try {
    const raw = await req.text();
    if (raw) {
      const parsed = JSON.parse(raw) as RemoveBody;
      if (parsed && typeof parsed === "object") {
        body = parsed;
      }
    }
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  return proxyDaemon(
    `/daemon/instances/${encodeURIComponent(id)}/remove`,
    { method: "POST", body },
  );
}
