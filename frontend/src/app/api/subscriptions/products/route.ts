import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import {
  createSubscriptionProduct,
  listSubscriptionProducts,
  SubscriptionError,
} from "@/lib/services/subscriptions";

export async function GET() {
  const products = await listSubscriptionProducts();
  return NextResponse.json({ products });
}

export async function POST(request: NextRequest) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const body = await request.json();
  const { name, description, amount_minor, billing_interval } = body;

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  if (!amount_minor || typeof amount_minor !== "number" || amount_minor <= 0) {
    return NextResponse.json(
      { error: "amount_minor must be a positive number" },
      { status: 400 },
    );
  }

  if (!billing_interval || !["week", "month"].includes(billing_interval)) {
    return NextResponse.json(
      { error: "billing_interval must be 'week' or 'month'" },
      { status: 400 },
    );
  }

  try {
    const product = await createSubscriptionProduct(agentId, {
      name,
      description,
      amountMinor: amount_minor,
      billingInterval: billing_interval,
    });

    return NextResponse.json(product, { status: 201 });
  } catch (err) {
    if (err instanceof SubscriptionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
