/**
 * [INPUT]: Supabase session via proxyHub
 * [OUTPUT]: GET /api/cloud-agents/api-token/balance — proxies to Hub
 * [POS]: BFF endpoint for Cloud Agent new-api token balance
 * [PROTOCOL]: update header on changes
 */

import { proxyHub } from "../../../_lib/proxy-hub";

export async function GET() {
  return proxyHub("/api/cloud-agents/api-token/balance", { method: "GET" });
}
