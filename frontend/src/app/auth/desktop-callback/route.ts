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
      button, a { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 0 18px; border: 1px solid #1f9fb4; border-radius: 10px; color: #22d3ee; text-decoration: none; background: rgba(34, 211, 238, 0.1); font: inherit; cursor: pointer; }
      iframe { display: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>Opening BotCord</h1>
      <p id="status">If this tab does not close automatically, you can close it after BotCord opens.</p>
      <a id="open" href=${JSON.stringify(deepLink)}>Open BotCord</a>
      <iframe id="handoff" title="BotCord handoff"></iframe>
    </main>
    <script>
      const target = ${JSON.stringify(deepLink)};
      const status = document.getElementById("status");
      const handoff = document.getElementById("handoff");
      const openButton = document.getElementById("open");

      function tryClose() {
        window.open("", "_self");
        window.close();
      }

      function openBotCord() {
        status.textContent = "Opening BotCord...";
        // Custom protocol launches from hidden iframes can be blocked by modern
        // browsers after OAuth redirects. A top-level navigation is the most
        // reliable handoff, with the iframe kept as a secondary trigger for
        // browsers that allow it.
        window.location.href = target;
        window.setTimeout(() => {
          handoff.src = target;
        }, 250);
        window.setTimeout(tryClose, 800);
        window.setTimeout(() => {
          status.textContent = "If BotCord did not open, use the Open BotCord button.";
        }, 1600);
      }

      openButton.addEventListener("click", openBotCord);
      window.setTimeout(openBotCord, 150);
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
