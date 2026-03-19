import { NextRequest } from "next/server";
import { getBoundAgentToken, proxyHubGet } from "@/app/api/_hub-proxy";

export async function GET(request: NextRequest) {
  const auth = await getBoundAgentToken();
  if (auth.error) return auth.error;

  return proxyHubGet("/hub/inbox", request.nextUrl.searchParams, auth.token);
}
