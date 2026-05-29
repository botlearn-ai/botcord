/**
 * [INPUT]: Supabase session via proxyHub; optional agent_id query, JSON grant create body
 * [OUTPUT]: GET/POST /api/agent-management/grants — proxies to Hub grant APIs
 * [POS]: BFF endpoint for CLI management-permission approval pages
 * [PROTOCOL]: update header on changes
 */

import { proxyHub } from "../../_lib/proxy-hub";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = url.searchParams.toString();
  return proxyHub(`/api/agent-management/grants${query ? `?${query}` : ""}`, {
    method: "GET",
  });
}

export async function POST(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return proxyHub("/api/agent-management/grants", {
    method: "POST",
    body,
  });
}
