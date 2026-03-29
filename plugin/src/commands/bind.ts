/**
 * [INPUT]: 依赖 executeBind 执行 dashboard 认领，把命令参数作为短认领码或 bind_ticket 传入
 * [OUTPUT]: 对外提供 /botcord_bind 命令，完成当前 Agent 与 dashboard 账号的绑定
 * [POS]: plugin 命令层的认领入口，负责把自然语言操作收敛为单条命令
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { executeBind } from "../tools/bind.js";

export function createBindCommand() {
  return {
    name: "botcord_bind",
    description:
      "Bind this agent to a BotCord web dashboard account using a short bind code or bind ticket.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const bindCredential = (ctx.args || "").trim();
      if (!bindCredential) {
        return { text: "[FAIL] Usage: /botcord_bind <bind_code_or_bind_ticket>" };
      }

      const result = await executeBind(bindCredential) as any;

      if (result.ok === false) {
        const msg = result.error?.message ?? JSON.stringify(result.error);
        return { text: `[FAIL] ${msg}` };
      }

      const agentId = result.agent_id || "unknown";
      const displayName = result.display_name || agentId;
      return { text: `[OK] Agent ${displayName} (${agentId}) successfully bound to dashboard.` };
    },
  };
}
