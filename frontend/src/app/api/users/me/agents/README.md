# agents/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/app/api/users/me/

用户-代理身份绑定 BFF：负责 agent 列表查询、绑定、解绑、默认身份切换，以及认领 key 解析。

## 成员清单

- `route.ts`: `GET/POST` 主入口，支持 `bind_proof + bind_ticket`（优先）与 `agent_token`（兼容）绑定。
- `bind-ticket/route.ts`: `POST` 颁发短时一次性 `bind_ticket` 与 `nonce`，供 Agent 自动调用绑定 API。
- `bind/route.ts`: `POST`（Agent 调用）使用 `agent_token + bind_ticket` 自动完成绑定，不要求浏览器继续提交 proof。
- `claim/resolve/route.ts`: `POST`（User 调用）使用 `claim_code` 直接完成认领，不依赖 `agent_token`。
- `[agentId]/route.ts`: `PATCH/DELETE` 单个 agent 管理（设默认、解绑）。

## 架构决策

- 浏览器只负责发放临时 `bind_ticket`；实际绑定可由 Agent 持 `agent_token + bind_ticket` 自动完成。
- `bind_ticket` 在 Next.js 层签发并校验（用户归属 + 时效）；保留 `nonce` 兼容旧的 `bind_proof` 签名链路。
- 认领流程使用固定 `claim_code` 进入页面；登录后调用 `claim/resolve` 直接完成认领。
- 用户侧认领不再要求 `agent_token`；`agent_token` 仅用于 Agent 侧自动绑定。
- Agent 认领为一次性动作：只要 `agents.user_id` 已存在（包括同一用户重复提交），统一返回 `409 Agent already claimed`。
- 通用绑定接口仍兼容 `bind_proof + bind_ticket`，以兼容历史绑定入口。

## 变更日志

- 2026-03-19: 新增 `bind-ticket/route.ts`，引入 `bind_ticket` 机制；`route.ts` 增加 `bind_proof + bind_ticket` 校验链路。
- 2026-03-19: 新增 `bind/route.ts`，允许 Agent 使用 `bind_ticket` 自动调用绑定 API，收敛 `/chats` 拦截弹框的创建/关联流程。
- 2026-03-19: 认领流程改为固定 `agent_key`，新增 `claim/resolve`，移除 `claim` 与旧 token-based `claim/resolve`。
- 2026-03-20: 认领流程改为固定 `claim_code`，`claim/resolve` 在登录后直接认领，不再依赖 `agent_token`。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
