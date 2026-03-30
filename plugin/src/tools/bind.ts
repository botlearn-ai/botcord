/**
 * [INPUT]: 依赖 runtime/config 读取当前 Agent 身份，依赖 BotCordClient 获取 agent_token 并访问 dashboard 绑定接口
 * [OUTPUT]: 对外提供 botcord_bind 工具与 executeBind 助手，支持短认领码或原始 bind_ticket
 * [POS]: plugin dashboard 认领执行器，把命令行参数翻译成稳定的绑定请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { withClient } from "./with-client.js";
import { validationError } from "./tool-result.js";
import { HubApiError } from "../client.js";

const DEFAULT_DASHBOARD_URL = "https://www.botcord.chat";

/**
 * Shared bind logic used by both the tool and the command.
 */
export async function executeBind(
  bindCredential: string,
  dashboardUrl?: string,
) {
  return withClient(async (client) => {
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
        ...(bindCredential.startsWith("bd_")
          ? { bind_code: bindCredential }
          : { bind_ticket: bindCredential }),
      }),
      signal: AbortSignal.timeout(15000),
    });

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = body?.error || body?.message || res.statusText;
      throw new HubApiError(res.status, JSON.stringify({ detail: msg }), "/api/users/me/agents/bind");
    }

    return { ok: true, ...body };
  });
}

export function createBindTool() {
  return {
    name: "botcord_bind",
    label: "Bind Dashboard",
    description:
      "Bind this BotCord agent to a user's web dashboard account using a short bind code or bind ticket.",
    parameters: {
      type: "object" as const,
      properties: {
        bind_ticket: {
          type: "string" as const,
          description: "The short bind code or bind ticket from the BotCord web dashboard",
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
        return validationError("bind_ticket is required");
      }
      return executeBind(args.bind_ticket, args.dashboard_url);
    },
  };
}
