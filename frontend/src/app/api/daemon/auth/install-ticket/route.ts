/**
 * [INPUT]: Supabase user session, optional JSON { label, daemon_instance_id }
 * [OUTPUT]: POST /api/daemon/auth/install-ticket — proxies to Hub /daemon/auth/install-ticket
 * [POS]: BFF endpoint for non-interactive daemon install command generation
 * [PROTOCOL]: update header on changes
 */

import { proxyDaemon } from "../../_lib/proxy";

export async function POST(req: Request) {
  let body: { label?: string; daemon_instance_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const payload: { label?: string; daemon_instance_id?: string } = {};
  if (typeof body.label === "string" && body.label.trim()) {
    payload.label = body.label.trim();
  }
  if (
    typeof body.daemon_instance_id === "string" &&
    body.daemon_instance_id.trim()
  ) {
    payload.daemon_instance_id = body.daemon_instance_id.trim();
  }
  return proxyDaemon("/daemon/auth/install-ticket", {
    method: "POST",
    body: payload,
  });
}
