# Frontend API 下沉到 Backend 迁移清单

## 1. 目标

把当前放在 `frontend` 的 Next.js Node API/BFF 能力迁移到 `backend` 的 FastAPI `/api/*` 路由中，最终让前端页面直接调用 backend，而不是先打 `frontend/src/app/api/*` 再转发。

迁移完成后的目标边界：

- `frontend` 负责页面、状态管理、Supabase 登录态读取、请求发起。
- `backend` 负责鉴权、业务校验、聚合查询、消息透传、对 Hub/数据库的访问。
- `frontend/src/app/api/*` 只保留确实必须在 Next 侧存在的路由，比如 auth callback；业务 API 路由原则上清空。

## 2. 当前现状

当前仓库里已经同时存在两套“前端可消费 API”：

- Next BFF:
  - `frontend/src/app/api/*`
- FastAPI app 层:
  - `backend/app/routers/*.py`

目前大量能力已经在 backend 存在，但 frontend 仍保留了一层 Node BFF，甚至直接查库：

- 典型 frontend BFF/查库入口：
  - `frontend/src/app/api/dashboard/overview/route.ts`
  - `frontend/src/app/api/public/overview/route.ts`
  - `frontend/src/app/api/stats/route.ts`
  - `frontend/src/app/api/users/me/agents/route.ts`
  - `frontend/src/app/api/users/me/agents/bind/route.ts`
- 已有 backend app 路由：
  - `backend/app/routers/dashboard.py`
  - `backend/app/routers/public.py`
  - `backend/app/routers/users.py`
  - `backend/app/routers/wallet.py`
  - `backend/app/routers/subscriptions.py`
  - `backend/app/routers/share.py`
  - `backend/app/routers/stats.py`

这意味着本次工作重点不是“从零做 backend API”，而是：

1. 补齐 backend 尚缺的接口。
2. 把 frontend 请求改为直连 backend。
3. 删除 frontend Node BFF。

## 3. 迁移原则

- 原则一：`/api/*` 的业务真相以 backend 为准。
- 原则二：前端不再直连数据库，不再在 Node 层做业务聚合。
- 原则三：对外响应结构尽量保持兼容，优先减少前端页面改动。
- 原则四：鉴权统一走 Supabase access token + `X-Active-Agent`。
- 原则五：先补 backend，再切 frontend，最后删 Next BFF。

## 4. 鉴权方案调整

### 4.1 当前方式

当前前端页面主要通过：

- 浏览器请求 `frontend` 本地 `/api/*`
- Next route handler 在服务端读取 Supabase session
- Next route handler 再补发：
  - `Authorization: Bearer <supabase access token>`
  - `X-Active-Agent: <agent_id>`

### 4.2 迁移后方式

前端页面直接请求 backend：

- Public 接口：
  - 不带 token
- User / Dashboard / Wallet / Subscriptions 接口：
  - `Authorization: Bearer <supabase access token>`
  - `X-Active-Agent: <agent_id>`，仅在需要 active agent 的接口上携带

### 4.3 需要做的事

- 在 `frontend/src/lib/api.ts` 中新增或重构 backend client：
  - 统一 base URL，例如 `NEXT_PUBLIC_API_BASE_URL`
  - 统一注入 bearer token
  - 统一注入 `X-Active-Agent`
  - 统一处理 `401/403/400/404`
- 保留当前 localStorage 中的 active agent 选择逻辑。
- 不再依赖 `frontend/src/app/api/*` 做 cookie-session BFF。

## 5. 接口映射清单

### 5.1 可直接迁移到 backend 的接口

这些接口 backend 已有对应能力，frontend 改请求目标即可。

| Frontend 路由 | Backend 路由 | 状态 | 说明 |
| --- | --- | --- | --- |
| `/api/stats` | `/api/stats` | 已有 | 可直接切换 |
| `/api/public/overview` | `/api/public/overview` | 已有 | 可直接切换 |
| `/api/public/rooms` | `/api/public/rooms` | 已有 | 可直接切换 |
| `/api/public/rooms/:roomId/members` | `/api/public/rooms/:roomId/members` | 已有 | 可直接切换 |
| `/api/public/rooms/:roomId/messages` | `/api/public/rooms/:roomId/messages` | 已有 | 可直接切换 |
| `/api/public/agents` | `/api/public/agents` | 已有 | 可直接切换 |
| `/api/public/agents/:agentId` | `/api/public/agents/:agentId` | 已有 | 可直接切换 |
| `/api/share/:shareId` | `/api/share/:shareId` | 已有 | 可直接切换 |
| `/api/dashboard/overview` | `/api/dashboard/overview` | 已有 | 可直接切换 |
| `/api/dashboard/agents/search` | `/api/dashboard/agents/search` | 已有 | 可直接切换 |
| `/api/dashboard/agents/:agentId` | `/api/dashboard/agents/:agentId` | 已有 | 可直接切换 |
| `/api/dashboard/agents/:agentId/conversations` | `/api/dashboard/agents/:agentId/conversations` | 已有 | 可直接切换 |
| `/api/dashboard/rooms/discover` | `/api/dashboard/rooms/discover` | 已有 | 可直接切换 |
| `/api/dashboard/rooms/:roomId/join` | `/api/dashboard/rooms/:roomId/join` | 已有 | 可直接切换 |
| `/api/dashboard/rooms/:roomId/read` | `/api/dashboard/rooms/:roomId/read` | 已有 | 可直接切换 |
| `/api/dashboard/rooms/:roomId/share` | `/api/dashboard/rooms/:roomId/share` | 已有 | 可直接切换 |
| `/api/dashboard/contact-requests` | `/api/dashboard/contact-requests` | 已有 | 可直接切换 |
| `/api/dashboard/contact-requests/received` | `/api/dashboard/contact-requests/received` | 已有 | 可直接切换 |
| `/api/dashboard/contact-requests/sent` | `/api/dashboard/contact-requests/sent` | 已有 | 可直接切换 |
| `/api/dashboard/contact-requests/:id/accept` | `/api/dashboard/contact-requests/:id/accept` | 已有 | 可直接切换 |
| `/api/dashboard/contact-requests/:id/reject` | `/api/dashboard/contact-requests/:id/reject` | 已有 | 可直接切换 |
| `/api/wallet/*` | `/api/wallet/*` | 已有 | summary/ledger/transfers/topups/withdrawals/stripe 均已有 |
| `/api/subscriptions/*` | `/api/subscriptions/*` | 已有 | products/me/subscribe/cancel 等已有 |
| `/api/users/me` | `/api/users/me` | 已有 | 可直接切换 |
| `/api/users/me/agents` `GET` | `/api/users/me/agents` `GET` | 已有 | 可直接切换 |
| `/api/users/me/agents/:agentId` `PATCH/DELETE` | 同路径 | 已有 | 可直接切换 |
| `/api/users/me/agents/bind-ticket` | 同路径 | 已有 | 可直接切换 |
| `/api/users/me/agents/claim/resolve` | 同路径 | 已有 | 可直接切换 |

### 5.2 backend 需要补齐的接口

这些接口目前 frontend 还在做，backend 尚未完整接住。

| 目标接口 | 当前实现位置 | 需要动作 |
| --- | --- | --- |
| `POST /api/users/me/agents` | `frontend/src/app/api/users/me/agents/route.ts` | 下沉到 `backend/app/routers/users.py` |
| `POST /api/users/me/agents/bind` | `frontend/src/app/api/users/me/agents/bind/route.ts` | 下沉到 `backend/app/routers/users.py` |
| `GET /api/dashboard/chat/room` | frontend 代理 `backend /dashboard/chat/room` | 在 backend app 层补别名或封装 |
| `POST /api/dashboard/chat/send` | frontend 代理 `backend /dashboard/chat/send` | 在 backend app 层补别名或封装 |
| `GET /api/dashboard/inbox` | frontend 代理 `backend /hub/inbox` | 在 backend app 层补 app 路由封装 |

### 5.3 需要重新确认返回结构的接口

这些接口虽然 backend 已有，但要对比当前 frontend route 的输出字段，避免页面隐性回归。

- `/api/dashboard/overview`
- `/api/public/overview`
- `/api/stats`
- `/api/users/me`
- `/api/users/me/agents`
- `/api/dashboard/rooms/:roomId/messages`
- `/api/public/rooms/:roomId/messages`
- `/api/wallet/summary`
- `/api/subscriptions/products/:productId`

重点核对：

- 时间字段是否仍是 ISO string
- 数字字段是否仍以 string 返回，例如 `amount_minor`
- 错误响应字段是否兼容 `detail` / `error`
- 分页字段命名是否一致

## 6. backend 改造清单

### 6.1 Users 路由补齐

在 `backend/app/routers/users.py` 中新增：

- `POST /api/users/me/agents`
  - 支持 `agent_token` 绑定
  - 支持 `bind_proof + bind_ticket` 绑定
  - 校验 agent 控制权
  - 校验用户 quota
  - 首个 agent 自动 `is_default=true`
  - 补 `agent_owner` 角色
- `POST /api/users/me/agents/bind`
  - 支持 agent 侧拿 `bind_ticket + agent_token` 直接绑定用户
  - 复用 bind ticket 校验逻辑

建议把以下逻辑抽成 backend 公共 helper/service，避免继续散在 route 中：

- bind ticket 解析与签发
- agent control verification
- claim/bind 配额校验
- role grant

### 6.2 Dashboard chat / inbox app 层封装

新增 backend app 层路由，例如：

- `GET /api/dashboard/chat/room`
- `POST /api/dashboard/chat/send`
- `GET /api/dashboard/inbox`

实现策略建议：

- 不让 frontend 继续直接打 `/dashboard/chat/*` 和 `/hub/inbox`
- 由 `backend/app/routers/` 新增轻量封装层
- 内部复用现有 `hub/routers/dashboard_chat.py` 和 hub inbox 逻辑

### 6.3 统一错误结构

backend 已在 `backend/hub/main.py` 中提供：

- `detail`
- `error`
- `retryable`

迁移时要确认新增 app 路由也遵守同一风格，减少 frontend 分支逻辑。

### 6.4 测试补充

需要新增或更新：

- `backend/tests/test_app/test_app_users.py`
  - agent bind
  - bind with proof
  - bind quota exceeded
  - duplicate claim
- `backend/tests/test_app/test_app_dashboard.py`
  - dashboard chat room
  - dashboard chat send
  - dashboard inbox

## 7. frontend 改造清单

### 7.1 重构 API client

修改 `frontend/src/lib/api.ts`：

- 废弃当前“默认请求本地 `/api/*`”的模式
- 改成直接请求 backend base URL
- 区分：
  - public request
  - authenticated request
  - active-agent request

建议新增能力：

- `getAccessToken()`
- `buildBackendHeaders({ requireAuth, requireActiveAgent })`
- `backendGet()`
- `backendPost()`
- `backendPatch()`
- `backendDelete()`

### 7.2 调整请求发起方式

页面和 store 保持尽量不动，只改 `api.ts` 的底层实现。

重点调用点：

- dashboard 页面数据加载
- contacts / explore / rooms / messages
- user profile / agents
- wallet
- subscriptions
- owner chat

### 7.3 下线 Next API routes

待 frontend 直连 backend 验证通过后，逐步删除：

- `frontend/src/app/api/stats/route.ts`
- `frontend/src/app/api/public/**/*`
- `frontend/src/app/api/dashboard/**/*`
- `frontend/src/app/api/wallet/**/*`
- `frontend/src/app/api/subscriptions/**/*`
- `frontend/src/app/api/users/me/**/*`
- `frontend/src/app/api/share/[shareId]/route.ts`
- `frontend/src/app/api/rooms/**/*`

保留项单独确认：

- `frontend/src/app/auth/callback/route.ts`
- 任何只和 Next/Supabase SSR 流程绑定、无法迁出的 route

### 7.4 中间件清理

当前 `frontend/src/proxy.ts` 会匹配 `/api/:path*` 做 session refresh。

迁移后要确认：

- 若业务 API 删除，则 `/api/:path*` matcher 可去掉或缩小范围
- 保留 `/auth/*`、`/login`、dashboard 页面本身需要的 session refresh

## 8. 建议实施顺序

### 阶段一：补 backend 能力

1. 在 backend 补齐缺失路由。
2. 用 pytest 覆盖新接口。
3. 确认 backend 单独即可承接全部前端业务 API。

### 阶段二：切 frontend 请求

1. 改 `frontend/src/lib/api.ts` 底层实现。
2. 保持组件层不动，优先减少页面改动面。
3. 本地联调所有关键路径。

### 阶段三：删除 Next BFF

1. 从 public/stats 开始删除。
2. 再删 dashboard/wallet/subscriptions。
3. 最后删 users bind/chat/inbox 相关 route。

### 阶段四：清理与收尾

1. 清理无用 helper：
   - `frontend/src/app/api/_hub-proxy.ts`
   - `frontend/src/lib/require-agent.ts` 中仅为 route handler 服务的部分
   - `frontend/src/lib/auth.ts` 中仅为 Node BFF 服务的部分
2. 清理 docs 与环境变量说明。
3. 更新部署文档。

## 9. 风险点

### 9.1 Auth 风险

- 浏览器直连 backend 后，token 获取与刷新链路会变化。
- 若 Supabase access token 获取失败，所有登录接口会直接 401。

需要验证：

- 登录后首屏加载
- token 过期后的重新获取
- 页面刷新后的 active agent 保持

### 9.2 CORS 风险

backend 目前在 `backend/hub/main.py` 中配置了 CORS。

迁移前要确认：

- 本地 `http://localhost:3000`
- 生产域名
- 预览域名

都允许直连 backend。

### 9.3 响应结构差异风险

frontend 现在很多页面默认信任当前 Next route 的输出格式。backend 直连后，如果字段名、空值、错误格式有差异，会导致页面静默坏掉。

### 9.4 消息类路径风险

`chat/send`、`chat/room`、`inbox` 涉及：

- active agent
- 消息入库
- inbox 唤醒
- 实时更新

这部分不建议最先切。

## 10. 验收清单

### 10.1 Backend

- `cd backend && uv run pytest tests/test_app/`
- 新增 app 路由测试全部通过
- 不依赖 frontend Node 层也能完成主要业务流

### 10.2 Frontend

- `cd frontend && npm run build`
- 登录态页面全部可加载
- 不再依赖 `frontend/src/app/api/*` 的业务接口

### 10.3 联调回归

- 游客首页 stats/overview 正常
- public rooms / agents 正常
- 登录后 overview 正常
- 切换 active agent 正常
- contacts / contact requests 正常
- room messages 正常
- room join / leave / read / share 正常
- owner chat room / send / inbox 正常
- users me / agents / claim / bind-ticket 正常
- wallet 全链路正常
- subscriptions 全链路正常

## 11. 推荐拆分任务

### Task A: backend 补接口

- owner: backend
- 产出：
  - users bind 路由补齐
  - dashboard chat/inbox app 路由补齐
  - pytest 补齐

### Task B: frontend 直连 backend client

- owner: frontend
- 产出：
  - `frontend/src/lib/api.ts` 重构
  - token/header 注入统一
  - 页面请求不再依赖本地 `/api/*`

### Task C: 删除 Next BFF

- owner: frontend
- 产出：
  - 删除 `frontend/src/app/api/*` 业务路由
  - 清理 `proxy.ts` matcher
  - 清理废弃 helper

## 12. 建议的最小闭环

如果想先做一版最小可落地闭环，建议先按这个范围推进：

1. backend 补 `POST /api/users/me/agents`
2. backend 补 `POST /api/users/me/agents/bind`
3. backend 补 `/api/dashboard/chat/room`
4. backend 补 `/api/dashboard/chat/send`
5. backend 补 `/api/dashboard/inbox`
6. frontend `api.ts` 改成直连 backend
7. 先切：
   - stats
   - public
   - dashboard overview
   - users/me
   - wallet
   - subscriptions
8. 最后切 chat / bind

这样可以先把主干架构定下来，再处理消息和绑定流程这些边界更复杂的能力。
