import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Runtime configuration for the ingress service. Values come from env
 * vars by default; the CLI / tests can build the object directly.
 */
export interface IngressConfig {
  /** Hub base URL the ingress calls (without trailing slash). */
  hubUrl: string;
  /** Shared secret matching the Hub's `CLOUD_GATEWAY_INGRESS_SECRET`. */
  ingressSecret: string;
  /** Root directory for connections / state / events / deliveries JSON. */
  dataDir: string;
  /** Root directory for per-gateway secret files (mode 0600). */
  secretDir: string;
  /** Health server bind port; 0 to disable. */
  healthPort: number;
  /** Health server bind host. */
  healthHost: string;
  /**
   * Internal setup HTTP server bind port; 0 to disable. Default 9101,
   * one above healthPort so a single host can run both side-by-side.
   */
  setupPort: number;
  /** Setup server bind host. Defaults to loopback. */
  setupHost: string;
  /** Admin sync server bind port; 0 to disable. */
  adminPort: number;
  /** Admin sync server bind host. */
  adminHost: string;
  /** Optional override for the runtime WS endpoint advertised by Hub. */
  runtimeEndpointOverride?: string;
  /**
   * Cap on the dedupe ring buffer per gateway. The truth still lives in
   * the events table; this is a fast-path to short-circuit duplicates
   * before any disk scan.
   */
  dedupeCapacity: number;
}

const DEFAULT_DATA_DIR = ".botcord/gateway-ingress/data";
const DEFAULT_SECRET_DIR = ".botcord/gateway-ingress/secrets";

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IngressConfig {
  const hubUrl = (env.BOTCORD_INGRESS_HUB_URL ?? "http://localhost:9000").replace(/\/+$/, "");
  const ingressSecret = env.BOTCORD_INGRESS_SECRET ?? "";
  const home = homedir();
  const dataDir = resolve(env.BOTCORD_INGRESS_DATA_DIR ?? join(home, DEFAULT_DATA_DIR));
  const secretDir = resolve(env.BOTCORD_INGRESS_SECRET_DIR ?? join(home, DEFAULT_SECRET_DIR));
  const healthPort = Number(env.BOTCORD_INGRESS_HEALTH_PORT ?? "9100");
  const healthHost = env.BOTCORD_INGRESS_HEALTH_HOST ?? "127.0.0.1";
  const setupPort = Number(env.BOTCORD_INGRESS_SETUP_PORT ?? "9101");
  const setupHost = env.BOTCORD_INGRESS_SETUP_HOST ?? "127.0.0.1";
  const adminPort = Number(env.BOTCORD_INGRESS_ADMIN_PORT ?? "0");
  const adminHost = env.BOTCORD_INGRESS_ADMIN_HOST ?? "127.0.0.1";
  const runtimeEndpointOverride = env.BOTCORD_INGRESS_RUNTIME_ENDPOINT;
  const dedupeCapacity = Number(env.BOTCORD_INGRESS_DEDUPE_CAPACITY ?? "1024");
  return {
    hubUrl,
    ingressSecret,
    dataDir,
    secretDir,
    healthPort: Number.isFinite(healthPort) ? healthPort : 0,
    healthHost,
    setupPort: Number.isFinite(setupPort) ? setupPort : 0,
    setupHost,
    adminPort: Number.isFinite(adminPort) ? adminPort : 0,
    adminHost,
    ...(runtimeEndpointOverride ? { runtimeEndpointOverride } : {}),
    dedupeCapacity: Number.isFinite(dedupeCapacity) && dedupeCapacity > 0 ? dedupeCapacity : 1024,
  };
}
