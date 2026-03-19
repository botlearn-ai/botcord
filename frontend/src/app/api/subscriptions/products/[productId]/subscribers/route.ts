import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import {
  getSubscriptionProduct,
  listProductSubscribers,
} from "@/lib/services/subscriptions";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const { productId } = await params;

  // Verify ownership
  const product = await getSubscriptionProduct(productId);
  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  if (product.owner_agent_id !== agentId) {
    return NextResponse.json(
      { error: "Only the product owner can view subscribers" },
      { status: 403 },
    );
  }

  const subscribers = await listProductSubscribers(productId);
  return NextResponse.json({ subscribers });
}
