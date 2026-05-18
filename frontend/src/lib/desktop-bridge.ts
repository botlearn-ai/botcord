/**
 * [INPUT]: window (browser or BotCord Desktop iframe)
 * [OUTPUT]: desktopBridge — thin adapter the Dashboard uses to talk to BotCord Desktop
 *   over postMessage. In a plain browser, every call resolves to `null` / `available()` is false.
 * [POS]: frontend leg of the desktop-embedded-dashboard design (Phase 2+)
 * [PROTOCOL]: update when bridge methods/capabilities/control-frames change
 */

"use client";

const SOURCE_TAG = "botcord-desktop-bridge";
const BRIDGE_ORIGIN_PARAM = "__botcord_bridge_origin";
const BRIDGE_NONCE_PARAM = "__botcord_bridge_nonce";
const BRIDGE_SESSION_KEY = "botcord.desktopBridge";
const WINDOW_NAME_PREFIX = "botcord-desktop-bridge:";
const HANDSHAKE_TIMEOUT_MS = 600;
const CALL_TIMEOUT_MS = 30_000;
const TRUSTED_PARENT_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://127.0.0.1:1420",
  "http://localhost:1420",
]);

type BridgeInfo = {
  appVersion: string;
  bridgeVersion: number;
  capabilities: string[];
};

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

type BridgeContext = {
  parentOrigin: string;
  nonce: string;
};

export type DesktopConfig = {
  daemonBin: string;
  hubUrl: string;
  dashboardUrl: string;
  label: string;
};

export type DesktopDaemonStatus = {
  pid: number | null;
  alive: boolean;
  agents: string[];
  agentsSource: "config" | "credentials" | null;
  config: string | null;
  userAuth: {
    userId: string;
    daemonInstanceId: string;
    hubUrl: string;
    expiresAt: number;
    label: string | null;
  } | null;
  authExpired: boolean;
  snapshotAgeMs: number | null;
};

export type DesktopServiceStatus = {
  supported: boolean;
  manager: "launchd" | "systemd" | "unsupported";
  installed: boolean;
  active: boolean;
  detail: string;
};

let pendingCalls = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: number }
>();

let listenerInstalled = false;
let infoPromise: Promise<BridgeInfo | null> | null = null;
let cachedInfo: BridgeInfo | null = null;
let cachedContext: BridgeContext | null | undefined;

function isInIframe(): boolean {
  try {
    return typeof window !== "undefined" && window.parent !== window;
  } catch {
    return false;
  }
}

function ensureListener(): void {
  if (listenerInstalled || typeof window === "undefined") return;
  listenerInstalled = true;
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as BridgeResponse | undefined;
    if (!data || data.source !== SOURCE_TAG || typeof data.id !== "string") return;
    const context = getBridgeContext();
    if (
      !context ||
      event.source !== window.parent ||
      event.origin !== context.parentOrigin ||
      data.nonce !== context.nonce
    ) {
      return;
    }
    const pending = pendingCalls.get(data.id);
    if (!pending) return;
    pendingCalls.delete(data.id);
    window.clearTimeout(pending.timer);
    if (data.ok) {
      pending.resolve(data.result);
    } else {
      pending.reject(new Error(data.error || "desktop bridge error"));
    }
  });
}

function trustedParentOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const origin =
      url.protocol === "tauri:" && url.hostname === "localhost"
        ? "tauri://localhost"
        : url.origin;
    return TRUSTED_PARENT_ORIGINS.has(origin) ? origin : null;
  } catch {
    return null;
  }
}

function getBridgeContext(): BridgeContext | null {
  if (typeof window === "undefined") return null;
  if (cachedContext !== undefined) return cachedContext;

  const params = new URLSearchParams(window.location.search);
  const origin = trustedParentOrigin(params.get(BRIDGE_ORIGIN_PARAM) ?? "");
  const nonce = params.get(BRIDGE_NONCE_PARAM);
  if (origin && nonce) {
    cachedContext = { parentOrigin: origin, nonce };
    rememberBridgeContext(cachedContext);
    return cachedContext;
  }

  const namedContext = parseWindowNameContext();
  if (namedContext) {
    cachedContext = namedContext;
    rememberBridgeContext(cachedContext);
    return cachedContext;
  }

  try {
    const stored = window.sessionStorage.getItem(BRIDGE_SESSION_KEY);
    const parsed = stored ? (JSON.parse(stored) as Partial<BridgeContext>) : null;
    const storedOrigin = trustedParentOrigin(parsed?.parentOrigin ?? "");
    if (storedOrigin && typeof parsed?.nonce === "string" && parsed.nonce) {
      cachedContext = { parentOrigin: storedOrigin, nonce: parsed.nonce };
      return cachedContext;
    }
  } catch {
    // Ignore malformed or inaccessible session state.
  }

  cachedContext = null;
  return null;
}

function rememberBridgeContext(context: BridgeContext): void {
  try {
    window.sessionStorage.setItem(BRIDGE_SESSION_KEY, JSON.stringify(context));
  } catch {
    // sessionStorage is best-effort; the current page can still use the bridge.
  }
}

function parseWindowNameContext(): BridgeContext | null {
  if (!window.name.startsWith(WINDOW_NAME_PREFIX)) return null;
  try {
    const parsed = JSON.parse(atob(window.name.slice(WINDOW_NAME_PREFIX.length))) as Partial<BridgeContext>;
    const parentOrigin = trustedParentOrigin(parsed.parentOrigin ?? "");
    if (parentOrigin && typeof parsed.nonce === "string" && parsed.nonce) {
      return { parentOrigin, nonce: parsed.nonce };
    }
  } catch {
    // Ignore unrelated window names.
  }
  return null;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function callRaw<T>(method: string, args?: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  const context = getBridgeContext();
  if (typeof window === "undefined" || !isInIframe() || !context) {
    return Promise.reject(new Error("desktop bridge is not available"));
  }
  ensureListener();
  const id = randomId();
  const payload: BridgeRequest = { source: SOURCE_TAG, id, nonce: context.nonce, method, args };
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`desktop bridge call timed out: ${method}`));
    }, timeoutMs);
    pendingCalls.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    try {
      window.parent.postMessage(payload, context.parentOrigin);
    } catch (err) {
      pendingCalls.delete(id);
      window.clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function probeInfo(): Promise<BridgeInfo | null> {
  try {
    return await callRaw<BridgeInfo>("info", undefined, HANDSHAKE_TIMEOUT_MS);
  } catch {
    return null;
  }
}

export function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  return isInIframe() && getBridgeContext() !== null;
}

/**
 * Probe the parent frame once and cache the result. Returns null in a plain browser.
 */
export async function getDesktopInfo(): Promise<BridgeInfo | null> {
  if (cachedInfo) return cachedInfo;
  if (!isDesktopApp()) return null;
  if (!infoPromise) {
    infoPromise = probeInfo().then((info) => {
      cachedInfo = info;
      return info;
    });
  }
  return infoPromise;
}

export async function isDesktopBridgeAvailable(): Promise<boolean> {
  const info = await getDesktopInfo();
  return info !== null;
}

export function hasCapability(info: BridgeInfo | null, capability: string): boolean {
  return !!info && info.capabilities.includes(capability);
}

export const desktopBridge = {
  available: isDesktopBridgeAvailable,
  info: getDesktopInfo,
  getConfig: () => callRaw<DesktopConfig>("config.get"),
  saveConfig: (config: DesktopConfig) => callRaw<void>("config.save", { config }),
  daemonStatus: () => callRaw<DesktopDaemonStatus>("daemon.status"),
  daemonStart: (input: { hubUrl: string; label?: string }) => callRaw<string>("daemon.start", input),
  daemonStop: () => callRaw<string>("daemon.stop"),
  daemonRestart: (input: { hubUrl: string; label?: string }) =>
    callRaw<string>("daemon.restart", input),
  openConnectPage: (input: { hubUrl: string; dashboardUrl: string; label?: string }) =>
    callRaw<string>("auth.openConnectPage", input),
  connectWithInstallToken: (input: { hubUrl: string; installToken: string; label?: string }) =>
    callRaw<string>("auth.connectWithInstallToken", input),
  serviceStatus: () => callRaw<DesktopServiceStatus>("service.status"),
  serviceInstall: (input: { hubUrl: string; label?: string }) =>
    callRaw<string>("service.install", input),
  serviceUninstall: () => callRaw<string>("service.uninstall"),
  logsTail: () => callRaw<string>("logs.tail"),
};

export type DesktopBridge = typeof desktopBridge;
