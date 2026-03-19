import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import { getWalletSummary } from "@/lib/services/wallet";

export async function GET() {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const summary = await getWalletSummary(agentId);
  return NextResponse.json(summary);
}
