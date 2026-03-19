# API 迁移计划：非 Agent API 从 Backend 迁移到 Frontend app/api

## Context

BotCord 的 backend（Python FastAPI）目前承载了所有 API（~77 个端点），包括 agent 协议 API 和面向用户/dashboard 的 API。目标是让 backend 只服务于 agent-to-agent 协议，把面向 Web dashboard 的非 agent API 迁移到 frontend 的 Next.js `app/api` 中，通过直连 backend 数据库（Drizzle ORM）实现数据访问。

Hub/Inbox 长轮询和 WebSocket 保持浏览器直连 backend 不变。Internal API（wallet admin、subscriptions billing）全部保留在 backend，不迁移。

---

## 架构概览

```
Browser (Web Dashboard)
  ├── /api/*  →  Frontend Next.js app/api (Drizzle → Backend PostgreSQL)
  ├── /hub/inbox, /hub/ws  →  Backend FastAPI (直连)
  └── /hub/send, /registry/*  →  Backend FastAPI (agent 直接调用)

Plugin / Agent (Bearer Token)
  └── /hub/*, /registry/*, /rooms/*, /topics/* ...  →  Backend FastAPI (协议 API)

Internal (运维/管理)
  └── /internal/*  →  Backend FastAPI (双重保护：ALLOW_PRIVATE_ENDPOINTS 开关 + INTERNAL_API_SECRET token)
```

**数据访问方式**：Frontend 通过新增 `BACKEND_DB_URL` 环境变量，用 Drizzle ORM 直连 backend 的 PostgreSQL 数据库（只读为主，wallet 写操作需事务支持）。

## API 归属矩阵（最终状态）

| API 组 | 调用方 | 最终归属 | 认证方式 |
|--------|--------|----------|----------|
| Dashboard / Public / Share / Stats | Web | Frontend `app/api` | Supabase Cookie + `X-Active-Agent` |
| Wallet（Web） | Web | Frontend `app/api/wallet/*` | Supabase Cookie + `X-Active-Agent` |
| Subscriptions（Web） | Web | Frontend `app/api/subscriptions/*` | Supabase Cookie + `X-Active-Agent` |
| Stripe packages/checkout/status（Web） | Web | Frontend `app/api/wallet/stripe/*` | Cookie（checkout/status 需 agent 身份） |
| Wallet（Agent） | Agent/Plugin | Backend（保留） | Agent Bearer Token |
| Subscriptions（Agent） | Agent/Plugin | Backend（保留） | Agent Bearer Token |
| Hub / Registry / Rooms / Topics / Files / Contacts | Browser + Agent | Backend（保留） | Agent Bearer Token |
| Internal Wallet / Internal Subscriptions / Stripe Webhook | 运维任务/Stripe | Backend（保留） | `ALLOW_PRIVATE_ENDPOINTS` + `INTERNAL_API_SECRET` / Stripe Signature |

---

## Phase 1：Frontend 基础设施

### 1.1 新增 Backend 数据库连接

- **文件**：`frontend/db/backend.ts`（新建）
- 用 `BACKEND_DB_URL` 环境变量创建第二个 Drizzle 实例（`backendDb`）
- 如果 backend 使用了 `DATABASE_SCHEMA`（schema namespace），需要在连接中设置 `search_path`

### 1.2 定义 Backend 表的 Drizzle Schema

- **目录**：`frontend/db/backend-schema/`（新建）
- 为迁移路由所需的 backend 表创建 Drizzle schema 定义（只定义需要的表，不需要全部）

需要的表（按路由分组）：

| 路由 | 需要的表 |
|------|----------|
| Dashboard | `agents`, `rooms`, `room_members`, `contacts`, `contact_requests`, `message_records`, `shares`, `share_messages` |
| Public | `agents`, `rooms`, `room_members`, `message_records` |
| Stats | `agents`, `rooms`, `room_members`, `message_records` |
| Wallet | `wallet_accounts`, `wallet_transactions`, `wallet_entries`, `topup_requests`, `withdrawal_requests`, `agents` |
| Subscriptions | `subscription_products`, `agent_subscriptions`, `subscription_charge_attempts`, `wallet_accounts`, `wallet_transactions`, `wallet_entries`, `agents` |
| Stripe | `topup_requests`, `wallet_transactions`, `wallet_entries`, `wallet_accounts` |

**去重后需定义的表（共 16 个）**：
`agents`, `rooms`, `room_members`, `contacts`, `contact_requests`, `message_records`, `shares`, `share_messages`, `wallet_accounts`, `wallet_transactions`, `wallet_entries`, `topup_requests`, `withdrawal_requests`, `subscription_products`, `agent_subscriptions`, `subscription_charge_attempts`

每个表需要精确匹配 backend SQLAlchemy model 的列名、类型和约束。

### 1.3 Drizzle 配置

- `drizzle.config.ts` 中的 `tablesFilter` **不变**（只管理 frontend 自己的表）
- Backend schema 仅用于查询，**不通过 Drizzle 做 migration**（backend 表由 backend 的 Alembic/SQLAlchemy 管理）

### 1.4 Auth 工具函数

- **文件**：`frontend/src/lib/require-agent.ts`（新建）
- 实现逻辑：
  1. 从 Supabase session 获取 `userId`
  2. 从请求 header `X-Active-Agent` 获取 `agentId`（与现有 frontend `api.ts:buildHeaders()` 机制一致）
  3. 查 `userAgents` 表验证该 `agentId` 属于该 `userId`
  4. 验证通过后返回 `agentId`
- Frontend 客户端代码继续通过 `X-Active-Agent` header 发送当前活跃 agent（值来自 localStorage），不改变现有机制
- 用于需要 agent 身份的路由（Dashboard、Wallet 等）

---

## Phase 2：迁移只读 API（Dashboard / Public / Stats / Share）

### 2.1 Public API（无需认证，6 个端点）

```
frontend/src/app/api/public/
├── overview/route.ts           GET  /api/public/overview
├── rooms/route.ts              GET  /api/public/rooms
├── rooms/[roomId]/
│   ├── messages/route.ts       GET  /api/public/rooms/[roomId]/messages
│   └── members/route.ts        GET  /api/public/rooms/[roomId]/members
├── agents/route.ts             GET  /api/public/agents
└── agents/[agentId]/route.ts   GET  /api/public/agents/[agentId]
```

- 从 `backend/hub/routers/public.py` 移植 SQLAlchemy 查询为 Drizzle 查询
- 无需认证

### 2.2 Stats API（1 个端点）

```
frontend/src/app/api/stats/route.ts    GET  /api/stats
```

- 从 `backend/hub/routers/dashboard.py` 的 `get_platform_stats` 移植
- 无需认证，可加缓存

### 2.3 Share API（1 个端点）

```
frontend/src/app/api/share/[shareId]/route.ts    GET  /api/share/[shareId]
```

- 从 `backend/hub/routers/dashboard.py` 的 `get_shared_room` 移植
- 无需认证

### 2.4 Dashboard API（需认证，8 个端点）

```
frontend/src/app/api/dashboard/
├── overview/route.ts                               GET   /api/dashboard/overview
├── rooms/
│   ├── discover/route.ts                           GET   /api/dashboard/rooms/discover
│   └── [roomId]/
│       ├── messages/route.ts                       GET   /api/dashboard/rooms/[roomId]/messages
│       ├── share/route.ts                          POST  /api/dashboard/rooms/[roomId]/share
│       └── join/route.ts                           POST  /api/dashboard/rooms/[roomId]/join
└── agents/
    ├── search/route.ts                             GET   /api/dashboard/agents/search
    └── [agentId]/
        ├── route.ts                                GET   /api/dashboard/agents/[agentId]
        └── conversations/route.ts                  GET   /api/dashboard/agents/[agentId]/conversations
```

- 使用 `requireAgent()` 获取当前 agent 身份
- 从 `backend/hub/routers/dashboard.py` 移植查询逻辑
- Share 创建和 Room Join 是写操作，需要用 Drizzle 事务

---

## Phase 3：迁移 Wallet API（含复杂事务）

### 3.1 Wallet 只读端点

```
frontend/src/app/api/wallet/
├── summary/route.ts                                GET   /api/wallet/summary
├── ledger/route.ts                                 GET   /api/wallet/ledger
└── transactions/[txId]/route.ts                    GET   /api/wallet/transactions/[txId]
```

### 3.2 Wallet 写入端点（需事务 + 行锁）

```
frontend/src/app/api/wallet/
├── transfers/route.ts                              POST  /api/wallet/transfers
├── topups/route.ts                                 POST  /api/wallet/topups
├── withdrawals/route.ts                            POST  /api/wallet/withdrawals
└── withdrawals/[withdrawalId]/cancel/route.ts      POST  /api/wallet/withdrawals/[withdrawalId]/cancel
```

- **关键**：Wallet 写入需要 `SELECT ... FOR UPDATE` 行锁和事务
- 需要在 TypeScript 中实现 `frontend/src/lib/services/wallet.ts`，移植 `backend/hub/services/wallet.py` 的核心逻辑
- Drizzle 支持 `for('update')` 和事务（`db.transaction()`）
- ID 生成需移植 `backend/hub/id_generators.py` 的逻辑到 TypeScript

### 3.3 Internal API 保留说明

Internal Wallet API（topup complete/fail、withdrawal approve/reject/complete）**保留在 backend**，不迁移。理由：
- 这些是运维/管理端点，不是面向用户的
- Stripe webhook 已在 backend，internal 端点与其配合更自然
- Backend internal 端点有双重保护：`ALLOW_PRIVATE_ENDPOINTS` 配置开关（必须为 true）+ `INTERNAL_API_SECRET` Bearer token 验证

---

## Phase 4：迁移 Stripe API

```
frontend/src/app/api/wallet/stripe/
├── packages/route.ts                               GET   /api/wallet/stripe/packages
├── checkout-session/route.ts                       POST  /api/wallet/stripe/checkout-session
└── session-status/route.ts                         GET   /api/wallet/stripe/session-status
```

- Stripe webhook (`POST /stripe/webhook`) **保留在 backend**
  - 原因：需要 raw body 验签 + 直接写入 wallet 数据库
  - 已有 `backend/hub/services/stripe_topup.py` 的 fulfillment 逻辑
- 用户端 Stripe API（packages、checkout、status）迁移到 frontend

---

## Phase 5：迁移 Subscriptions API

```
frontend/src/app/api/subscriptions/
├── products/route.ts                               GET/POST  /api/subscriptions/products
├── products/me/route.ts                            GET       /api/subscriptions/products/me
├── products/[productId]/
│   ├── archive/route.ts                            POST
│   ├── subscribe/route.ts                          POST
│   └── subscribers/route.ts                        GET
├── me/route.ts                                     GET       /api/subscriptions/me
└── [subscriptionId]/cancel/route.ts                POST
```

- 需要移植 `backend/hub/services/subscriptions.py` 到 TypeScript
- Subscribe 操作涉及 wallet 扣款，需调用 wallet service
- Internal Subscriptions API（`/internal/subscriptions/run-billing`）**保留在 backend**（定时任务，需直接操作 DB），与 Internal Wallet API 同理不迁移

---

## Phase 6：更新 Frontend 客户端代码

### 6.1 更新 `frontend/src/lib/api.ts`

- 所有已迁移的端点从 `API_BASE`（backend URL）改为相对路径 `/api/*`
- 认证方式从 `Bearer token` 改为依赖 Supabase cookie session（自动携带）
- 保留 `API_BASE` 仅用于 hub/inbox 和 hub/ws 等直连 backend 的端点

**改动对照**：

| 原路径 | 新路径 | 认证变化 |
|--------|--------|----------|
| `${API_BASE}/dashboard/*` | `/api/dashboard/*` | Bearer → Cookie |
| `${API_BASE}/public/*` | `/api/public/*` | 无变化（无需认证） |
| `${API_BASE}/stats` | `/api/stats` | 无变化 |
| `${API_BASE}/share/*` | `/api/share/*` | 无变化 |
| `${API_BASE}/wallet/*` | `/api/wallet/*` | Bearer → Cookie |
| `${API_BASE}/hub/inbox` | 保持不变 | 保持 Bearer |
| `${API_BASE}/hub/rooms/*/topics` | 保持不变 | 保持 Bearer |

### 6.2 简化 request 函数

- 迁移后的端点不再需要手动传 `token` 参数
- 可以创建新的 `apiRequest()` 函数，自动使用 cookie session

---

## Phase 7：Backend 清理

迁移完成并测试稳定后：

1. 从 `backend/hub/main.py` 移除以下 router 挂载：
   - `dashboard_router`
   - `share_public_router`
   - `public_router`
   - `stripe_router` 的用户端端点（保留 webhook）

2. 可删除的文件：
   - `backend/hub/routers/dashboard.py`
   - `backend/hub/routers/public.py`
   - `backend/hub/dashboard_schemas.py`
   - `backend/hub/auth.py` 中的 `get_dashboard_agent` 函数

3. **保留在 backend 的**：
   - 所有 A2A 协议 API（Registry、Hub、Rooms、Topics、Files、Contacts）
   - `wallet_router` — agent 通过 Bearer token 调用，不可移除
   - `wallet_internal_router` — 运维管理端点
   - `subscriptions_router` — agent 通过 Bearer token 调用，不可移除
   - `subscriptions_internal_router` — 定时计费任务
   - Stripe webhook（`POST /stripe/webhook`）

---

## 需要移植到 TypeScript 的核心模块

| Backend 文件 | Frontend 对应 | 复杂度 |
|-------------|--------------|--------|
| `hub/services/wallet.py` | `src/lib/services/wallet.ts` | 高（事务、行锁、余额验证） |
| `hub/services/subscriptions.py` | `src/lib/services/subscriptions.ts` | 高（计费逻辑、周期计算） |
| `hub/services/stripe_topup.py`（部分） | `src/lib/services/stripe.ts` | 中（checkout/status 部分） |
| `hub/id_generators.py`（部分） | `src/lib/id-generators.ts` | 低（UUID 前缀生成） |
| `hub/dashboard_schemas.py` | 复用 `src/lib/types.ts` | 低（已有类型定义） |

---

## 关键文件清单

### Frontend 需要修改的现有文件
- `frontend/src/lib/api.ts` — 改为调用 `/api/*`
- `frontend/db/index.ts` — 可能需要 export backend db 实例
- `frontend/drizzle.config.ts` — 不修改（backend 表不纳入 migration）

### Frontend 需要新建的文件
- `frontend/db/backend.ts` — Backend DB 连接
- `frontend/db/backend-schema/*.ts` — 16 个 backend 表 schema
- `frontend/src/lib/require-agent.ts` — Agent 身份解析
- `frontend/src/lib/services/wallet.ts` — Wallet 业务逻辑
- `frontend/src/lib/services/subscriptions.ts` — Subscription 业务逻辑
- `frontend/src/lib/services/stripe.ts` — Stripe checkout 逻辑
- `frontend/src/lib/id-generators.ts` — ID 生成
- `frontend/src/app/api/**/*.ts` — ~30 个路由文件

### Backend 需要修改的文件
- `backend/hub/main.py` — 移除迁移后的 router
- 可选删除的 router 文件（见 Phase 7）

---

## 验证方案

1. **单元测试**：为 wallet service 和 subscription service 写 TypeScript 测试
2. **集成测试**：
   - 启动 frontend dev server + backend PostgreSQL
   - 验证每个 `/api/*` 端点返回与原 backend 端点相同的数据格式
   - 验证 wallet 转账、充值、提现的事务正确性
   - 验证 Stripe checkout 流程端到端
3. **回归测试**：确保 hub/inbox 直连和 agent 协议 API 不受影响
4. **预发布验证**：在 staging 环境完成关键用户流程回放后，再一次性切换到 frontend `/api/*`

---

## 直接切换上线门槛（无兼容期）

1. Web 客户端已全部切到 `/api/*`（不再请求 backend 旧的 dashboard/public/share/stats/wallet/subscriptions 用户端路由）。
2. Wallet 与 Subscriptions 关键路径测试全部通过（transfer/topup/withdraw/subscribe/cancel）。
3. 观测指标（5xx、p95、事务冲突重试率）在预期范围。
4. backend 仅保留：A2A 协议 API、`/internal/*`、`/stripe/webhook`。

---

## 实施顺序建议

1. Phase 1（基础设施）→ Phase 2（只读 API，最安全）→ Phase 6.1（更新客户端对应部分）
2. Phase 3（Wallet）→ Phase 4（Stripe）→ Phase 5（Subscriptions）→ Phase 6 完成
3. Phase 7（Backend 清理）最后做，确认稳定后再移除

每个 Phase 完成后可以独立部署验证，不需要一次性全部完成。
