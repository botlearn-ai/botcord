import type { BotCordClient } from "@botcord/protocol-core";
import { log } from "./log.js";

/**
 * Post a stream block to the Hub's /hub/stream-block endpoint. Only meaningful
 * for owner-chat rooms (rm_oc_*) — the Hub drops the frame otherwise.
 *
 * Uses the client's internal authenticated fetch. We cast to `any` because
 * `hubFetch` is private; we could expose a public helper in protocol-core, but
 * keeping the surface small for now.
 */
export async function postStreamBlock(
  client: BotCordClient,
  traceId: string,
  seq: number,
  block: unknown,
): Promise<void> {
  const hubUrl = client.getHubUrl();
  try {
    const token = await client.ensureToken();
    const resp = await fetch(`${hubUrl}/hub/stream-block`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ trace_id: traceId, seq, block }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok && resp.status !== 204) {
      const body = await resp.text().catch(() => "");
      log.warn("stream-block post non-ok", { status: resp.status, body: body.slice(0, 200) });
    }
  } catch (err) {
    log.warn("stream-block post failed", { err: String(err) });
  }
}
