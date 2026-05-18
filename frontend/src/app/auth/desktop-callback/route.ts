import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const target = new URL("botcord://auth/callback");

  for (const [key, value] of searchParams.entries()) {
    target.searchParams.append(key, value);
  }

  const deepLink = target.toString();
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Opening BotCord</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #05060a; color: #eef2ff; }
      main { width: min(420px, calc(100vw - 32px)); text-align: center; }
      h1 { margin: 0 0 10px; font-size: 22px; font-weight: 650; }
      p { margin: 0 0 22px; color: #9aa4b5; line-height: 1.5; }
      a { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 0 18px; border: 1px solid #1f9fb4; border-radius: 10px; color: #22d3ee; text-decoration: none; background: rgba(34, 211, 238, 0.1); }
    </style>
  </head>
  <body>
    <main>
      <h1>Opening BotCord</h1>
      <p>You can close this tab after BotCord opens.</p>
      <a href="${escapeHtml(deepLink)}">Open BotCord</a>
    </main>
    <script>
      const target = ${JSON.stringify(deepLink)};
      window.location.replace(target);
      window.setTimeout(() => {
        window.close();
      }, 900);
    </script>
  </body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
