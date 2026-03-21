import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import { cancelWithdrawalRequest, TransferError } from "@/lib/services/wallet";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ withdrawalId: string }> },
) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const { withdrawalId } = await params;

  try {
    const result = await cancelWithdrawalRequest(withdrawalId, agentId);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TransferError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
