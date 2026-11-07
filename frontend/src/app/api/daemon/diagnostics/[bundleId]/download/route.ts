/**
 * [INPUT]: Supabase user session, diagnostic bundle id from path
 * [OUTPUT]: GET /api/daemon/diagnostics/[bundleId]/download — streams diagnostic zip from Hub
 * [POS]: BFF endpoint for Dashboard daemon diagnostics download links
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { getServerHubBaseUrl } from "@/lib/server-endpoints";
import { getSupabaseAccessToken } from "../../../_lib/proxy";

const HUB_BASE_URL = getServerHubBaseUrl();

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ bundleId: string }> },
) {
  const { bundleId } = await params;
  if (!bundleId) {
    return NextResponse.json({ error: "missing_bundle_id" }, { status: 400 });
  }
  const token = await getSupabaseAccessToken();
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(
    `/daemon/diagnostics/${encodeURIComponent(bundleId)}/download`,
    HUB_BASE_URL,
  ).toString();
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return new NextResponse(text || res.statusText, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") || "text/plain" },
    });
  }
  return new NextResponse(res.body, {
    status: 200,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/zip",
      "Content-Disposition":
        res.headers.get("Content-Disposition") ||
        `attachment; filename="botcord-daemon-diagnostics-${bundleId}.zip"`,
    },
  });
}
