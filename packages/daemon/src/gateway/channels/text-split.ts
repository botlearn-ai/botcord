/**
 * Thin re-export — `splitText` lives in `@botcord/protocol-core` so the
 * daemon channel adapters and the `gateway-ingress` provider adapters use
 * one canonical implementation. Existing imports of this module keep
 * working unchanged.
 */
export { splitText } from "@botcord/protocol-core";
