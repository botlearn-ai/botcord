import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import {
  cancelSubscription,
  SubscriptionError,
} from "@/lib/services/subscriptions";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const { subscriptionId } = await params;

  try {
    const result = await cancelSubscription(subscriptionId, agentId);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SubscriptionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
