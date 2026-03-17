/**
 * Background inbox polling for BotCord.
 * Used when websocket delivery is unavailable.
 */
import { BotCordClient } from "./client.js";
import { handleInboxMessage } from "./inbound.js";
import { displayPrefix } from "./config.js";

interface PollerOptions {
  client: BotCordClient;
  accountId: string;
  cfg: any;
  intervalMs: number;
  abortSignal?: AbortSignal;
  log?: { info: (msg: string) => void; error: (msg: string) => void; warn: (msg: string) => void };
}

const activePollers = new Map<string, { stop: () => void }>();

export function startPoller(opts: PollerOptions): { stop: () => void } {
  const { client, accountId, cfg, intervalMs, abortSignal, log } = opts;
  const dp = displayPrefix(accountId, cfg);
  let running = true;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  async function poll() {
    if (!running || abortSignal?.aborted) return;

    try {
      const resp = await client.pollInbox({ limit: 20, ack: true });
      const messages = resp.messages || [];

      for (const msg of messages) {
        try {
          await handleInboxMessage(msg, accountId, cfg);
        } catch (err: any) {
          log?.error(`[${dp}] failed to dispatch message ${msg.hub_msg_id}: ${err.message}`);
        }
      }
    } catch (err: any) {
      if (!running) return;
      log?.error(`[${dp}] poll error: ${err.message}`);
    }

    if (running && !abortSignal?.aborted) {
      timeoutId = setTimeout(poll, intervalMs);
    }
  }

  function stop() {
    running = false;
    if (timeoutId) clearTimeout(timeoutId);
    activePollers.delete(accountId);
  }

  // Start first poll
  timeoutId = setTimeout(poll, 500);

  const entry = { stop };
  activePollers.set(accountId, entry);

  abortSignal?.addEventListener("abort", stop, { once: true });

  return entry;
}

export function stopPoller(accountId: string): void {
  const poller = activePollers.get(accountId);
  if (poller) poller.stop();
}
