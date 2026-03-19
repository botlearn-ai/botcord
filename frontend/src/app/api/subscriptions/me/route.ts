import { NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import { listMySubscriptions } from "@/lib/services/subscriptions";

export async function GET() {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const subscriptions = await listMySubscriptions(agentId);
  return NextResponse.json({ subscriptions });
}
