import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import { listWalletLedger } from "@/lib/services/wallet";

export async function GET(request: NextRequest) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const url = request.nextUrl;
  const cursor = url.searchParams.get("cursor");
  const limit = url.searchParams.get("limit");
  const type = url.searchParams.get("type");

  const result = await listWalletLedger(agentId, {
    cursor: cursor ? parseInt(cursor, 10) : undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
    type: type ?? undefined,
  });

  return NextResponse.json(result);
}
