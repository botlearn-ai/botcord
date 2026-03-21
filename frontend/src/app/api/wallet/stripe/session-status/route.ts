import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/require-agent";
import {
  getCheckoutStatus,
  StripeServiceError,
} from "@/lib/services/stripe";

export async function GET(request: NextRequest) {
  const { agentId, error } = await requireAgent();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const sessionId = request.nextUrl.searchParams.get("session_id");

  if (!sessionId) {
    return NextResponse.json(
      { error: "session_id query param is required" },
      { status: 400 },
    );
  }

  try {
    const result = await getCheckoutStatus(sessionId, agentId);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof StripeServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
