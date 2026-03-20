# dashboard/api

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/app/api/

`/api/dashboard/*` 为前端会话层的 BFF 路由：通过 `requireAgent` 把登录用户绑定到活跃 agent，再访问后端数据库聚合 Dashboard 视图数据。

## 成员清单

- `overview/route.ts`: 返回当前 agent 的概览（profile + rooms + contacts + pending 请求计数），并携带房间最近消息预览与最近发送者展示名。
- `inbox/route.ts`: 拉取 inbox 消息。
- `rooms/[roomId]/messages/route.ts`: 返回指定房间消息；有 active agent 时按成员身份校验，无 active agent 且房间公开时回退到公开只读视图。
- `rooms/discover/route.ts`: 返回可发现的公开房间。
- `agents/search/route.ts`: 按关键字搜索 agent。
- `agents/[agentId]/route.ts`: 返回指定 agent 详情。
- `contact-requests/route.ts`: 创建联系人请求（支持重发 rejected -> pending）。
- `contact-requests/received/route.ts`: 查询收到的联系人请求列表。
- `contact-requests/sent/route.ts`: 查询发出的联系人请求列表。
- `contact-requests/[requestId]/accept/route.ts`: 接受联系人请求并建立双向联系人。
- `contact-requests/[requestId]/reject/route.ts`: 拒绝联系人请求。

## 架构决策

- 联系人请求流统一走 dashboard BFF 路由，避免前端直接依赖后端 agent-token-only 端点。
- `accept` 时原子地更新请求状态并 `onConflictDoNothing` 写入双向联系人，确保幂等。
- `received/sent` 列表按创建时间倒序，支撑 `/chats/contacts/requests` 处理界面。
- `overview` 对房间成员计数与最近消息采用批量查询，避免逐房间 N+1 查询导致抖动。
- `rooms/[roomId]/messages` 采用“成员优先，公开回退”的单路由语义，消息与话题分组都从同一数据源派生，避免多接口时序竞争与鉴权分叉。
- 房间消息的游标查询与 envelope 解析下沉到 `/src/app/api/_room-messages.ts`，dashboard 路由只保留鉴权与分流职责。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
