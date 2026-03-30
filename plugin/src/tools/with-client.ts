/**
 * Shared tool wrapper that eliminates boilerplate across all BotCord tools.
 *
 * Handles: config check → single-account guard → account resolution →
 * client creation → token persistence → try/catch with error classification.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { attachTokenPersistence } from "../credentials.js";
import { getConfig as getAppConfig } from "../runtime.js";
import type { BotCordAccountConfig } from "../types.js";
import { configError, classifyError, type ToolFailure, type ToolSuccess } from "./tool-result.js";

/**
 * Run a tool action with a fully-configured BotCordClient.
 *
 * The callback receives the client and resolved account config.
 * If it returns a plain object, it is automatically wrapped in `{ ok: true, ... }`.
 * If it returns an object that already has `ok` set, it is passed through as-is.
 */
export async function withClient<T extends Record<string, unknown>>(
  fn: (client: BotCordClient, acct: BotCordAccountConfig) => Promise<T | ToolSuccess<T> | ToolFailure>,
): Promise<ToolSuccess<T> | ToolFailure> {
  const cfg = getAppConfig();
  if (!cfg) {
    return configError("No configuration available", "Run /botcord_healthcheck to diagnose");
  }

  const singleErr = getSingleAccountModeError(cfg);
  if (singleErr) {
    return configError(singleErr);
  }

  const acct = resolveAccountConfig(cfg);
  if (!isAccountConfigured(acct)) {
    return configError(
      "BotCord is not configured.",
      "Run botcord-register to create an identity or botcord-import to restore one",
    );
  }

  try {
    const client = new BotCordClient(acct);
    attachTokenPersistence(client, acct);
    const result = await fn(client, acct);

    // If the callback already returned a structured result, pass through
    if (result && typeof result === "object" && "ok" in result) {
      return result as ToolSuccess<T> | ToolFailure;
    }

    // Otherwise wrap in success envelope
    return { ok: true, ...result } as ToolSuccess<T>;
  } catch (err: unknown) {
    return classifyError(err);
  }
}

/**
 * Lightweight version that only checks config availability (no client creation).
 * Used by tools that don't need a BotCordClient (e.g. register, notify).
 */
export async function withConfig<T extends Record<string, unknown>>(
  fn: (cfg: any, acct: BotCordAccountConfig) => Promise<T | ToolSuccess<T> | ToolFailure>,
): Promise<ToolSuccess<T> | ToolFailure> {
  const cfg = getAppConfig();
  if (!cfg) {
    return configError("No configuration available", "Run /botcord_healthcheck to diagnose");
  }

  const singleErr = getSingleAccountModeError(cfg);
  if (singleErr) {
    return configError(singleErr);
  }

  const acct = resolveAccountConfig(cfg);

  try {
    const result = await fn(cfg, acct);

    if (result && typeof result === "object" && "ok" in result) {
      return result as ToolSuccess<T> | ToolFailure;
    }

    return { ok: true, ...result } as ToolSuccess<T>;
  } catch (err: unknown) {
    return classifyError(err);
  }
}
