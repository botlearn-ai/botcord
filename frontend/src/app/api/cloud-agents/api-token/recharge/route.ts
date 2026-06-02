/**
 * [INPUT]: Supabase session + { amount_usd }
 * [OUTPUT]: POST /api/cloud-agents/api-token/recharge — proxies to Hub
 * [POS]: BFF endpoint for Cloud Agent new-api token recharge
 * [PROTOCOL]: update header on changes
 */

import { proxyHub } from "../../../_lib/proxy-hub";

export async function POST(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return proxyHub("/api/cloud-agents/api-token/recharge", { method: "POST", body });
}
