import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import { createTopupRequest, TransferError } from "@/lib/services/wallet";

export async function POST(request: NextRequest) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const body = await request.json();
  const { amount_minor, channel, metadata, idempotency_key } = body;

  if (!amount_minor || typeof amount_minor !== "number" || amount_minor <= 0) {
    return NextResponse.json(
      { error: "amount_minor must be a positive number" },
      { status: 400 },
    );
  }

  try {
    const result = await createTopupRequest(agentId, amount_minor, {
      channel,
      metadata,
      idempotencyKey: idempotency_key,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof TransferError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
