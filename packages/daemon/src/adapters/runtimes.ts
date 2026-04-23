/**
 * Thin pass-through to the local gateway module's runtime registry. The daemon CLI
 * (`doctor`, `config`, `init`, `route`) uses these to probe, list, and
 * validate adapter ids.
 */
import {
  detectRuntimes as gatewayDetectRuntimes,
  getRuntimeModule,
  listRuntimeIds,
  type RuntimeModule,
  type RuntimeProbeEntry as GatewayRuntimeProbeEntry,
} from "../gateway/index.js";

/** Lookup an adapter module by id, or null when the id is unknown. */
export function getAdapterModule(id: string): RuntimeModule | null {
  return getRuntimeModule(id);
}

/** All registered adapter ids in registration order. */
export function listAdapterIds(): string[] {
  return listRuntimeIds();
}

/** One probe result per registered adapter, for `doctor`-style listings. */
export type RuntimeProbeEntry = GatewayRuntimeProbeEntry;

/** Probe every registered adapter and report installation status. */
export function detectRuntimes(): RuntimeProbeEntry[] {
  return gatewayDetectRuntimes();
}
