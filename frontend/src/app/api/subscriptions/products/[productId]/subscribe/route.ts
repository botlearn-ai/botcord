import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import {
  createSubscription,
  SubscriptionError,
} from "@/lib/services/subscriptions";
import { TransferError } from "@/lib/services/wallet";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const { productId } = await params;
  const body = await request.json().catch(() => ({}));
  const { idempotency_key } = body as { idempotency_key?: string };

  try {
    const result = await createSubscription(
      productId,
      agentId,
      idempotency_key,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof SubscriptionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof TransferError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
