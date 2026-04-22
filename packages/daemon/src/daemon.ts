import {
  BotCordClient,
  loadStoredCredentials,
  updateCredentialsToken,
  defaultCredentialsFile,
} from "@botcord/protocol-core";
import type { DaemonConfig } from "./config.js";
import { SessionStore } from "./session-store.js";
import { Dispatcher } from "./dispatcher.js";
import { startHubWs } from "./hub-ws.js";
import { log } from "./log.js";

export interface RunHandle {
  stop: () => Promise<void>;
  wait: () => Promise<void>;
}

export async function runDaemon(cfg: DaemonConfig): Promise<RunHandle> {
  const credFile = defaultCredentialsFile(cfg.agentId);
  const creds = loadStoredCredentials(credFile);

  const client = new BotCordClient({
    hubUrl: creds.hubUrl,
    agentId: creds.agentId,
    keyId: creds.keyId,
    privateKey: creds.privateKey,
    token: creds.token,
    tokenExpiresAt: creds.tokenExpiresAt,
  });
  client.onTokenRefresh = (token, expiresAt) => {
    try {
      updateCredentialsToken(credFile, token, expiresAt);
    } catch (err) {
      log.warn("credential persist failed", { err: String(err) });
    }
  };

  const store = new SessionStore();
  const dispatcher = new Dispatcher(client, cfg, store);

  const rootCtrl = new AbortController();
  const ws = startHubWs({
    client,
    hubUrl: creds.hubUrl,
    agentId: cfg.agentId,
    abortSignal: rootCtrl.signal,
    onInboxUpdate: () => dispatcher.drainInbox(),
  });

  log.info("daemon started", { agentId: cfg.agentId, hubUrl: creds.hubUrl });

  let stopping = false;
  const stopped = new Promise<void>((resolve) => {
    rootCtrl.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  async function stop() {
    if (stopping) return stopped;
    stopping = true;
    log.info("daemon stopping");
    ws.stop();
    dispatcher.cancelAll();
    store.flushSync();
    rootCtrl.abort();
    return stopped;
  }

  return { stop, wait: () => stopped };
}
