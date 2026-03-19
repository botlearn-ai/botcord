import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import { getTransaction } from "@/lib/services/wallet";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ txId: string }> },
) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const { txId } = await params;
  const tx = await getTransaction(txId);

  if (!tx) {
    return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
  }

  // Verify the agent is sender or receiver
  if (tx.from_agent_id !== agentId && tx.to_agent_id !== agentId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  return NextResponse.json(tx);
}
