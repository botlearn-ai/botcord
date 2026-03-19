import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import { createTransfer, TransferError } from "@/lib/services/wallet";

export async function POST(request: NextRequest) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const body = await request.json();
  const {
    to_agent_id,
    amount_minor,
    memo,
    reference_type,
    reference_id,
    metadata,
    idempotency_key,
  } = body;

  if (!to_agent_id || typeof to_agent_id !== "string") {
    return NextResponse.json({ error: "to_agent_id is required" }, { status: 400 });
  }

  const parsedAmount =
    typeof amount_minor === "number"
      ? amount_minor
      : typeof amount_minor === "string"
        ? parseInt(amount_minor, 10)
        : NaN;

  if (!Number.isInteger(parsedAmount) || parsedAmount <= 0) {
    return NextResponse.json(
      { error: "amount_minor must be a positive number" },
      { status: 400 },
    );
  }

  try {
    const result = await createTransfer(agentId, to_agent_id, parsedAmount, {
      memo,
      referenceType: reference_type,
      referenceId: reference_id,
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
