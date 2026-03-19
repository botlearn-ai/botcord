# agents/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/app/api/users/me/

用户-代理身份绑定 BFF：负责 agent 列表查询、绑定、解绑、默认身份切换，以及一次性 `bind_ticket` 颁发。

## 成员清单

- `route.ts`: `GET/POST` 主入口，支持 `bind_proof + bind_ticket`（优先）与 `agent_token`（兼容）绑定。
- `bind-ticket/route.ts`: `POST` 颁发短时一次性 `bind_ticket` 与 `nonce`，供 Agent 自动调用绑定 API。
- `bind/route.ts`: `POST`（Agent 调用）使用 `agent_token + bind_ticket` 自动完成绑定，不要求浏览器继续提交 proof。
- `claim/route.ts`: `POST`（Agent 调用）转发至 Backend `/registry/agents/{id}/claim` 签发短时认领链接。
- `claim/resolve/route.ts`: `POST`（User 调用）转发至 Backend `/registry/claims/resolve` 校验 token，并为当前登录用户签发 `bind_ticket + nonce`。
- `[agentId]/route.ts`: `PATCH/DELETE` 单个 agent 管理（设默认、解绑）。

## 架构决策

- 浏览器只负责发放临时 `bind_ticket`；实际绑定可由 Agent 持 `agent_token + bind_ticket` 自动完成。
- `bind_ticket` 在 Next.js 层签发并校验（用户归属 + 时效）；保留 `nonce` 兼容旧的 `bind_proof` 签名链路。
- `claim_link` 的签发与验签都在 Backend 完成；Frontend 只处理登录态和用户绑定票据。
- 保留 `agent_token` 兼容路径，保证历史客户端不中断。

## 变更日志

- 2026-03-19: 新增 `bind-ticket/route.ts`，引入 `bind_ticket` 机制；`route.ts` 增加 `bind_proof + bind_ticket` 校验链路。
- 2026-03-19: 新增 `claim` 与 `claim/resolve`，支持激活认领链接流程。
- 2026-03-19: 新增 `bind/route.ts`，允许 Agent 使用 `bind_ticket` 自动调用绑定 API，收敛 `/chats` 拦截弹框的创建/关联流程。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
