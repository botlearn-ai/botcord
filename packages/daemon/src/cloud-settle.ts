/**
 * Cloud Agent run settle helper.
 *
 * After a `cloud_run` envelope completes (or fails), the daemon can POST the
 * observed usage back to the Hub when the envelope enables settlement. The
 * Hub-side endpoint is
 * `POST /internal/cloud-agents/runs/{run_id}/settle` — see
 * ``backend/hub/services/cloud_agent_usage.py``.
 *
 * Auth: the cloud daemon authenticates with its cloud-daemon-access JWT
 * (the same token used for the WS upgrade). The Hub-side endpoint accepts
 * either that JWT (scoped to the daemon's bound agents) or the operator
 * `INTERNAL_API_SECRET` header — see ``hub/routers/cloud_agent_internal.py``.
 */
import { normalizeAndValidateHubUrl } from "@botcord/protocol-core";

/** Token usage breakdown reported alongside the wall-clock time. */
export interface CloudRunSettleUsage {
  provider: string;
  model: string;
  inputCacheHitTokens: number;
  inputCacheMissTokens: number;
  outputTokens: number;
  sandboxSeconds: number;
}

/** Inputs accepted by {@link postCloudRunSettle}. */
export interface CloudRunSettleInput extends CloudRunSettleUsage {
  hubUrl: string;
  accessToken: string;
  runId: string;
  /** Override the idempotency key. Defaults to `<run_id>:settle`. */
  idempotencyKey?: string;
  /** Test seam — override `fetch`. */
  fetchFn?: typeof fetch;
  /** Override timeout for the POST. Defaults to 10s. */
  timeoutMs?: number;
}

/** Outcome of {@link postCloudRunSettle}. */
export interface CloudRunSettleResult {
  ok: boolean;
  status: number;
  /** Raw response body, when the Hub returned one. */
  body?: unknown;
}

/**
 * POST the settle payload to the Hub. Resolves with `ok=false` for non-2xx
 * responses instead of throwing so the caller can decide whether to retry
 * or surface the failure into the runtime log; throws only on transport
 * errors (timeout / DNS) which are fully outside the daemon's control.
 *
 * Body shape matches the Hub-side `UsageEventCreate`-like contract:
 *
 *   {
 *     "provider":                <str>,
 *     "model":                   <str>,
 *     "input_cache_hit_tokens":  <int>,
 *     "input_cache_miss_tokens": <int>,
 *     "output_tokens":           <int>,
 *     "sandbox_seconds":         <int>,
 *     "idempotency_key":         "<run_id>:settle"
 *   }
 *
 * Snake_case is intentional: the Hub's Pydantic models use snake_case for
 * the public surface even when the surrounding daemon control plane uses
 * camelCase.
 */
export interface CloudRunSettleHookDeps {
  hubUrl: string;
  accessToken: string;
  /** Fallback model name when the envelope doesn't carry one. */
  defaultModel?: string;
  /** Logger surface — only `warn` / `info` used. */
  log?: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
  };
  /** Test seam. */
  fetchFn?: typeof fetch;
}

/** Minimal subset of an inbound message needed by the settle hook. */
export interface CloudRunSettleHookEvent {
  envelopeType?: string | undefined;
  runId?: string | undefined;
  /** Explicit false disables Hub usage settlement for this run. */
  settleUsage?: boolean | undefined;
  wallTimeMs: number;
  tokens?: {
    inputCacheHitTokens?: number;
    inputCacheMissTokens?: number;
    outputTokens?: number;
  };
  messageId?: string;
}

/**
 * Build the settle hook used by ``startCloudDaemon``. Extracted so unit
 * tests can drive it directly without standing up the full gateway.
 */
export function buildCloudRunSettleHook(
  deps: CloudRunSettleHookDeps,
): (event: CloudRunSettleHookEvent) => Promise<void> {
  const log = deps.log;
  const model = deps.defaultModel ?? "deepseek-v4-flash";
  return async (event) => {
    if (event.envelopeType !== "cloud_run") return;
    if (event.settleUsage === false) {
      return;
    }
    const runId = event.runId;
    if (typeof runId !== "string" || runId.length === 0) {
      log?.warn("cloud_run envelope missing run_id; skipping settle", {
        messageId: event.messageId ?? "<unknown>",
      });
      return;
    }
    const sandboxSeconds = Math.max(1, Math.round(event.wallTimeMs / 1000));
    try {
      const settleResult = await postCloudRunSettle({
        hubUrl: deps.hubUrl,
        accessToken: deps.accessToken,
        runId,
        provider: "deepseek",
        model,
        // The deepseek-tui adapter does not yet surface token counts;
        // ``UsageService`` charges by sandbox-seconds when tokens are
        // zero. Filling these in is the next runtime-adapter PR.
        inputCacheHitTokens: event.tokens?.inputCacheHitTokens ?? 0,
        inputCacheMissTokens: event.tokens?.inputCacheMissTokens ?? 0,
        outputTokens: event.tokens?.outputTokens ?? 0,
        sandboxSeconds,
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
      if (!settleResult.ok) {
        log?.warn("cloud_run settle returned non-2xx", {
          runId,
          status: settleResult.status,
        });
      } else {
        log?.info("cloud_run settled", { runId, sandboxSeconds });
      }
    } catch (err) {
      // Transport errors only — Hub-side rejections surface as ok=false.
      log?.warn("cloud_run settle threw — continuing", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export async function postCloudRunSettle(
  input: CloudRunSettleInput,
): Promise<CloudRunSettleResult> {
  const base = normalizeAndValidateHubUrl(input.hubUrl);
  const url = `${base}/internal/cloud-agents/runs/${encodeURIComponent(input.runId)}/settle`;
  const idempotencyKey = input.idempotencyKey ?? `${input.runId}:settle`;
  const body = {
    provider: input.provider,
    model: input.model,
    input_cache_hit_tokens: Math.max(0, Math.floor(input.inputCacheHitTokens)),
    input_cache_miss_tokens: Math.max(0, Math.floor(input.inputCacheMissTokens)),
    output_tokens: Math.max(0, Math.floor(input.outputTokens)),
    sandbox_seconds: Math.max(0, Math.floor(input.sandboxSeconds)),
    idempotency_key: idempotencyKey,
  };
  const doFetch = input.fetchFn ?? fetch;
  const resp = await doFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  });
  let parsed: unknown = undefined;
  try {
    parsed = await resp.json();
  } catch {
    // Empty body on 204, etc. — leave parsed as undefined.
  }
  return { ok: resp.ok, status: resp.status, body: parsed };
}
