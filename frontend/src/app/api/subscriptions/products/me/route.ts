import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import { listSubscriptionProducts } from "@/lib/services/subscriptions";

export async function GET() {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const products = await listSubscriptionProducts({ ownerAgentId: agentId });
  return NextResponse.json({ products });
}
