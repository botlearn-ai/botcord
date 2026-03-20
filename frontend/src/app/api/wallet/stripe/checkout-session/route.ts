import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import {
  createCheckoutSession,
  StripeServiceError,
} from "@/lib/services/stripe";

export async function POST(request: NextRequest) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const body = await request.json();
  const { package_code, idempotency_key, quantity } = body;

  if (!package_code || typeof package_code !== "string") {
    return NextResponse.json(
      { error: "package_code is required" },
      { status: 400 },
    );
  }

  const qty = typeof quantity === "number" ? Math.max(1, Math.min(100, Math.trunc(quantity))) : 1;

  try {
    const result = await createCheckoutSession(
      agentId,
      package_code,
      idempotency_key,
      qty,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof StripeServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
