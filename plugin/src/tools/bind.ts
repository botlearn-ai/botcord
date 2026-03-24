/**
 * botcord_bind — Bind this BotCord agent to a user's web dashboard account.
 *
 * Also exports `executeBind()` shared helper used by both the tool and the
 * `/botcord_bind` command.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { getConfig as getAppConfig } from "../runtime.js";

const DEFAULT_DASHBOARD_URL = "https://www.botcord.chat";

/**
 * Shared bind logic used by both the tool and the command.
 */
export async function executeBind(
  bindTicket: string,
  dashboardUrl?: string,
): Promise<{ ok: true; [key: string]: unknown } | { error: string }> {
  const cfg = getAppConfig();
  if (!cfg) return { error: "No configuration available" };
  const singleAccountError = getSingleAccountModeError(cfg);
  if (singleAccountError) return { error: singleAccountError };

  const acct = resolveAccountConfig(cfg);
  if (!isAccountConfigured(acct)) {
    return { error: "BotCord is not configured." };
  }

  const client = new BotCordClient(acct);

  try {
    const agentToken = await client.ensureToken();
    const agentId = client.getAgentId();

    const resolved = (await client.resolve(agentId)) as Record<string, unknown>;
    const displayName = (resolved.display_name as string) || agentId;

    const baseUrl = (dashboardUrl || DEFAULT_DASHBOARD_URL).replace(/\/+$/, "");

    const res = await fetch(`${baseUrl}/api/users/me/agents/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        display_name: displayName,
        agent_token: agentToken,
        bind_ticket: bindTicket,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = body?.error || body?.message || res.statusText;
      return { error: `Dashboard bind failed (${res.status}): ${msg}` };
    }

    return { ok: true, ...body };
  } catch (err: any) {
    return { error: `Bind failed: ${err.message}` };
  }
}

export function createBindTool() {
  return {
    name: "botcord_bind",
    label: "Bind Dashboard",
    description:
      "Bind this BotCord agent to a user's web dashboard account using a bind ticket.",
    parameters: {
      type: "object" as const,
      properties: {
        bind_ticket: {
          type: "string" as const,
          description: "The bind ticket from the BotCord web dashboard",
        },
        dashboard_url: {
          type: "string" as const,
          description: `Dashboard base URL (defaults to ${DEFAULT_DASHBOARD_URL})`,
        },
      },
      required: ["bind_ticket"],
    },
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
      if (!args.bind_ticket) {
        return { error: "bind_ticket is required" };
      }
      return executeBind(args.bind_ticket, args.dashboard_url);
    },
  };
}
