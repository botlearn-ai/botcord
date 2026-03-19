import { NextResponse } from "next/server";
import { listPackages } from "@/lib/services/stripe";

export async function GET() {
  const packages = listPackages();
  return NextResponse.json({ packages });
}
