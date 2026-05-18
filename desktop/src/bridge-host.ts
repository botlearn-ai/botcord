/**
 * postMessage bridge host.
 *
 * The Dashboard iframe at `dashboardUrl` calls into the desktop shell by posting
 * messages with `source: "botcord-desktop-bridge"`. We validate the origin,
 * dispatch to the matching Tauri command, and reply with `{ ok, result | error }`.
 *
 * Only allow-listed methods are exposed. No generic `invoke` passthrough.
 */

import { invoke } from "@tauri-apps/api/core";

const BRIDGE_VERSION = 1;
const APP_VERSION = "0.1.0";
const SOURCE_TAG = "botcord-desktop-bridge";
const TRUSTED_DASHBOARD_ORIGINS = new Set([
  "https://botcord.chat",
  "https://preview.botcord.chat",
]);
const DEV_DASHBOARD_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

type BridgeRequest = {
  source: typeof SOURCE_TAG;
  id: string;
  nonce: string;
  method: string;
  args?: Record<string, unknown>;
};

type BridgeResponse =
  | { source: typeof SOURCE_TAG; id: string; nonce: string; ok: true; result: unknown }
  | { source: typeof SOURCE_TAG; id: string; nonce: string; ok: false; error: string };

let bridgeFrame: Window | null = null;
let bridgeNonce: string | null = null;

const CAPABILITIES = [
  "info",
  "config.get",
  "config.save",
  "daemon.status",
  "daemon.start",
  "daemon.stop",
  "daemon.restart",
  "auth.openConnectPage",
  "auth.connectWithInstallToken",
  "service.status",
  "service.install",
  "service.uninstall",
  "logs.tail",
];

const HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  info: async () => ({
    appVersion: APP_VERSION,
    bridgeVersion: BRIDGE_VERSION,
    capabilities: CAPABILITIES,
  }),
  "config.get": () => invoke("get_config"),
  "config.save": (args) => invoke("save_config", { config: args.config }),
  "daemon.status": () => invoke("get_daemon_status"),
  "daemon.start": (args) =>
    invoke("start_daemon", { hubUrl: args.hubUrl, label: args.label ?? "" }),
  "daemon.stop": () => invoke("stop_daemon"),
  "daemon.restart": (args) =>
    invoke("restart_daemon", { hubUrl: args.hubUrl, label: args.label ?? "" }),
  "auth.openConnectPage": (args) =>
    invoke("open_connect_page", {
      hubUrl: args.hubUrl,
      dashboardUrl: args.dashboardUrl,
      label: args.label ?? "",
    }),
  "auth.connectWithInstallToken": (args) =>
    invoke("connect_with_install_token", {
      hubUrl: args.hubUrl,
      installToken: args.installToken,
      label: args.label ?? "",
    }),
  "service.status": () => invoke("get_service_status"),
  "service.install": (args) =>
    invoke("install_service", { hubUrl: args.hubUrl, label: args.label ?? "" }),
  "service.uninstall": () => invoke("uninstall_service"),
  "logs.tail": () => invoke("tail_logs"),
};

function originOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

export type BridgeHostOptions = {
  getAllowedOrigins: () => string[];
  onRequest?: (method: string) => void;
};

export function installBridgeHost(options: BridgeHostOptions): () => void {
  const listener = async (event: MessageEvent) => {
    const data = event.data as BridgeRequest | undefined;
    if (!data || data.source !== SOURCE_TAG || typeof data.id !== "string") return;

    if (event.source !== bridgeFrame || !bridgeNonce || data.nonce !== bridgeNonce) {
      replyError(event, data.id, data.nonce ?? "", "bridge frame not registered");
      return;
    }

    const allowed = options.getAllowedOrigins();
    if (!allowed.includes(event.origin)) {
      replyError(event, data.id, data.nonce, `origin not allowed: ${event.origin}`);
      return;
    }

    const handler = HANDLERS[data.method];
    if (!handler) {
      replyError(event, data.id, data.nonce, `unknown method: ${data.method}`);
      return;
    }

    options.onRequest?.(data.method);
    try {
      const result = await handler(data.args ?? {});
      reply(event, { source: SOURCE_TAG, id: data.id, nonce: data.nonce, ok: true, result });
    } catch (err) {
      replyError(event, data.id, data.nonce, err instanceof Error ? err.message : String(err));
    }
  };

  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

function reply(event: MessageEvent, payload: BridgeResponse): void {
  const target = event.source as Window | null;
  if (!target) return;
  target.postMessage(payload, { targetOrigin: event.origin });
}

function replyError(event: MessageEvent, id: string, nonce: string, error: string): void {
  reply(event, { source: SOURCE_TAG, id, nonce, ok: false, error });
}

export function allowedOriginsFromConfig(dashboardUrl: string): string[] {
  const origins = new Set<string>();
  const primary = originOf(dashboardUrl);
  if (primary && TRUSTED_DASHBOARD_ORIGINS.has(primary)) origins.add(primary);
  for (const origin of TRUSTED_DASHBOARD_ORIGINS) origins.add(origin);
  if (import.meta.env.DEV) {
    for (const origin of DEV_DASHBOARD_ORIGINS) origins.add(origin);
  }
  return Array.from(origins);
}

export function registerBridgeFrame(frame: Window | null, nonce: string): () => void {
  bridgeFrame = frame;
  bridgeNonce = nonce;
  return () => {
    if (bridgeFrame === frame && bridgeNonce === nonce) {
      bridgeFrame = null;
      bridgeNonce = null;
    }
  };
}

export { SOURCE_TAG as BRIDGE_SOURCE_TAG, BRIDGE_VERSION, APP_VERSION, CAPABILITIES };
