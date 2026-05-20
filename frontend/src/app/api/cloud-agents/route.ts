/**
 * [INPUT]: Supabase session via proxyHub; POST body is a Cloud Agent create payload
 * [OUTPUT]: GET/POST /api/cloud-agents — proxies to Hub Cloud Agent APIs
 * [POS]: BFF endpoint for CreateAgentDialog cloud-hosted Bot creation
 * [PROTOCOL]: update header on changes
 */

import { proxyHub } from "../_lib/proxy-hub";

export async function GET() {
  return proxyHub("/api/cloud-agents", { method: "GET" });
}

export async function POST(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return proxyHub("/api/cloud-agents", { method: "POST", body });
}
