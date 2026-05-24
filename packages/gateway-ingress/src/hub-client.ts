import type {
  EnsureRunningRequest,
  EnsureRunningResponse,
  TouchRuntimeRequest,
  TouchRuntimeResponse,
} from "@botcord/protocol-core";

/**
 * Thin client for the Hub's
 * `/internal/cloud-gateway/agents/{agent_id}/...` API. The ingress never
 * sends provider message bodies through this client — only gateway id,
 * reason, and the durable event id for log correlation.
 */
export interface HubClientOptions {
  baseUrl: string;
  /** Bearer secret matching the Hub's `CLOUD_GATEWAY_INGRESS_SECRET`. */
  ingressSecret: string;
  fetchImpl?: typeof fetch;
  /** Override the runtime endpoint Hub returned, useful for relay setups. */
  runtimeEndpointOverride?: string;
}

export interface HubClient {
  ensureRunning(
    agentId: string,
    body: EnsureRunningRequest,
  ): Promise<EnsureRunningResponse>;
  getRuntime(
    agentId: string,
    params: { gatewayId: string; eventId?: string },
  ): Promise<EnsureRunningResponse>;
  touch(agentId: string, body: TouchRuntimeRequest): Promise<TouchRuntimeResponse>;
}

export class HubClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HubClientError";
  }
}

function authHeaders(secret: string): Record<string, string> {
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
}

export function createHubClient(opts: HubClientOptions): HubClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: authHeaders(opts.ingressSecret),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const resp = await fetchImpl(url, init);
    if (!resp.ok) {
      let detail: { detail?: string; code?: string } | null = null;
      try {
        detail = (await resp.json()) as { detail?: string; code?: string };
      } catch {
        detail = null;
      }
      throw new HubClientError(
        resp.status,
        detail?.code ?? `http_${resp.status}`,
        detail?.detail ?? `Hub returned ${resp.status} for ${method} ${path}`,
      );
    }
    return (await resp.json()) as T;
  }

  return {
    async ensureRunning(agentId, body) {
      const res = await call<EnsureRunningResponse>(
        "POST",
        `/internal/cloud-gateway/agents/${encodeURIComponent(agentId)}/ensure-running`,
        body,
      );
      return maybeOverrideEndpoint(res, opts.runtimeEndpointOverride);
    },
    async getRuntime(agentId, params) {
      const query = new URLSearchParams({ gateway_id: params.gatewayId });
      if (params.eventId) query.set("event_id", params.eventId);
      const res = await call<EnsureRunningResponse>(
        "GET",
        `/internal/cloud-gateway/agents/${encodeURIComponent(agentId)}/runtime?${query.toString()}`,
      );
      return maybeOverrideEndpoint(res, opts.runtimeEndpointOverride);
    },
    async touch(agentId, body) {
      return call<TouchRuntimeResponse>(
        "POST",
        `/internal/cloud-gateway/agents/${encodeURIComponent(agentId)}/touch`,
        body,
      );
    },
  };
}

function maybeOverrideEndpoint(
  res: EnsureRunningResponse,
  override: string | undefined,
): EnsureRunningResponse {
  if (!override || !res.runtime) return res;
  return {
    ...res,
    runtime: { ...res.runtime, session_endpoint: override },
  };
}
