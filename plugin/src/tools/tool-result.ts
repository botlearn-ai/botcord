/**
 * Structured tool result types and builder helpers.
 *
 * Provides a unified response envelope for all BotCord tools:
 * - Success: { ok: true, ...data }
 * - Failure: { ok: false, error: { type, code, message, hint? } }
 * - DryRun:  { ok: true, dry_run: true, request: { method, path, body? } }
 */

// ── Error types ─────────────────────────────────────────────────

export type ToolErrorType = "config" | "auth" | "validation" | "api" | "network";

export interface ToolError {
  type: ToolErrorType;
  code: string;
  message: string;
  hint?: string;
}

// ── Result types ────────────────────────────────────────────────

export type ToolSuccess<T = Record<string, unknown>> = { ok: true } & T;
export type ToolFailure = { ok: false; error: ToolError };
export type ToolResult<T = Record<string, unknown>> = ToolSuccess<T> | ToolFailure;

export interface DryRunRequest {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | string[]>;
  note?: string;
}

export type DryRunResult = { ok: true; dry_run: true; request: DryRunRequest };

// ── Builder helpers ─────────────────────────────────────────────

export function success<T extends Record<string, unknown>>(data: T): ToolSuccess<T> {
  return { ok: true, ...data };
}

export function fail(
  type: ToolErrorType,
  code: string,
  message: string,
  hint?: string,
): ToolFailure {
  return { ok: false, error: { type, code, message, ...(hint ? { hint } : {}) } };
}

export function configError(message: string, hint?: string): ToolFailure {
  return fail("config", "NOT_CONFIGURED", message, hint);
}

export function validationError(message: string, hint?: string): ToolFailure {
  return fail("validation", "INVALID_INPUT", message, hint);
}

export function apiError(code: string, message: string, hint?: string): ToolFailure {
  return fail("api", code, message, hint);
}

export function dryRunResult(method: string, path: string, body?: unknown, options?: { query?: Record<string, string | string[]>; note?: string }): DryRunResult {
  return {
    ok: true,
    dry_run: true,
    request: {
      method,
      path,
      ...(body !== undefined ? { body } : {}),
      ...(options?.query ? { query: options.query } : {}),
      ...(options?.note ? { note: options.note } : {}),
    },
  };
}

// ── Error classifier ────────────────────────────────────────────

import { HubApiError } from "../client.js";

/**
 * Classify a caught error into a structured ToolFailure.
 * Uses HubApiError's typed status and code properties.
 */
export function classifyError(err: unknown): ToolFailure {
  if (!(err instanceof Error)) {
    return fail("api", "UNKNOWN", String(err));
  }

  const message = err.message;

  // Network-level failures
  if (
    err.name === "AbortError" ||
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ENOTFOUND") ||
    message.includes("network")
  ) {
    return fail("network", "CONNECTION_FAILED", message, "Check Hub URL and network connectivity");
  }

  // Typed Hub API errors
  if (err instanceof HubApiError) {
    const { status, code } = err;
    switch (status) {
      case 401:
        return fail("auth", "TOKEN_EXPIRED", message, "Token refresh may have failed — try again or re-register");
      case 403:
        return fail("auth", code || "FORBIDDEN", message);
      case 404:
        return fail("api", "NOT_FOUND", message, "Verify the target ID exists via botcord_directory(action=\"resolve\")");
      case 409:
        return fail("api", "CONFLICT", message);
      case 422:
        return fail("validation", "UNPROCESSABLE", message);
      case 429:
        return fail("api", "RATE_LIMITED", message, "Throttle requests — 20 msg/min global, 10 msg/min per conversation");
      default:
        return fail("api", code || `HTTP_${status}`, message);
    }
  }

  return fail("api", "UNKNOWN", message);
}
