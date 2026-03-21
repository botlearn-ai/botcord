import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import {
  createWithdrawalRequest,
  listWithdrawalRequests,
  TransferError,
} from "@/lib/services/wallet";

export async function GET() {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  try {
    const result = await listWithdrawalRequests(agentId, 8);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TransferError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function POST(request: NextRequest) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const body = await request.json();
  const {
    amount_minor,
    fee_minor,
    destination_type,
    destination,
    idempotency_key,
  } = body;

  if (!amount_minor || typeof amount_minor !== "number" || amount_minor <= 0) {
    return NextResponse.json(
      { error: "amount_minor must be a positive number" },
      { status: 400 },
    );
  }

  try {
    const result = await createWithdrawalRequest(agentId, amount_minor, {
      feeMinor: fee_minor,
      destinationType: destination_type,
      destination,
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
