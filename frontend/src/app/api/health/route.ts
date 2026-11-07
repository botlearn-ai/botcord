export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { status: "ok", service: "botcord-web" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
