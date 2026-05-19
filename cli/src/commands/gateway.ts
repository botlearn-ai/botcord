import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";
import { outputError, outputJson } from "../output.js";

export async function gatewayCommand(
  args: ParsedArgs,
  globalHub?: string,
  globalAgent?: string,
): Promise<void> {
  if (args.flags["help"] || args.subcommand !== "send") {
    console.log(`Usage: botcord gateway send --gateway <id> --conversation <id> --text <msg> [options]

Send a message through a configured third-party gateway.

Options:
  --gateway <id>        Gateway connection ID (required)
  --conversation <id>   Provider conversation ID, e.g. telegram:group:-100... or feishu:chat:oc_... (required)
  --text <msg>          Message text (required)
  --idempotency-key <k> Optional request key forwarded to the daemon`);
    return;
  }

  const gatewayId = args.flags["gateway"];
  const conversationId = args.flags["conversation"];
  const text = args.flags["text"];
  if (!gatewayId || typeof gatewayId !== "string") outputError("--gateway is required");
  if (!conversationId || typeof conversationId !== "string") {
    outputError("--conversation is required");
  }
  if (!text || typeof text !== "string") outputError("--text is required");

  const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
  const hubUrl = normalizeAndValidateHubUrl(globalHub || creds.hubUrl);

  const client = new BotCordClient({
    hubUrl,
    agentId: creds.agentId,
    keyId: creds.keyId,
    privateKey: creds.privateKey,
    token: creds.token,
    tokenExpiresAt: creds.tokenExpiresAt,
  });

  const idempotencyKey =
    typeof args.flags["idempotency-key"] === "string"
      ? args.flags["idempotency-key"]
      : undefined;

  const token = await client.ensureToken();
  const resp = await fetch(`${hubUrl.replace(/\/+$/, "")}/hub/gateways/${encodeURIComponent(gatewayId)}/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      conversationId,
      text,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`gateway send failed: ${resp.status} ${body}`);
  }
  const result = await resp.json();
  outputJson(result);
}
