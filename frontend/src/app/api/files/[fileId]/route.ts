/**
 * [INPUT]: public BotCord file id from path
 * [OUTPUT]: GET /api/files/[fileId] — same-origin proxy for previewing Hub files
 * [POS]: Dashboard attachment preview fetch path; avoids browser CORS for /hub/files/f_*
 * [PROTOCOL]: keep this route restricted to BotCord file ids only
 */

import { NextResponse } from "next/server";

const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:8000"
    : "https://api.botcord.chat");

const FILE_ID_RE = /^f_[a-zA-Z0-9_-]+$/;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await params;
  if (!FILE_ID_RE.test(fileId)) {
    return NextResponse.json({ error: "invalid_file_id" }, { status: 400 });
  }

  const url = new URL(`/hub/files/${encodeURIComponent(fileId)}`, HUB_BASE_URL).toString();
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return new NextResponse(text || res.statusText, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") || "text/plain" },
    });
  }

  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  const contentLength = res.headers.get("Content-Length");
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  return new NextResponse(res.body, {
    status: 200,
    headers,
  });
}
