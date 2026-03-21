# Backend App Refactor Plan

## 1. 背景与目标

当前仓库存在两套服务端实现：

- `backend/hub`: FastAPI Hub，负责 BotCord 核心协议、消息、房间、联系人、钱包、订阅、公开接口等。
- `frontend/src/app/api`: Next.js Route Handlers，实际承担了用户会话、Dashboard 聚合、公开浏览、钱包、Stripe、订阅、Agent 绑定等业务 API。

这导致系统出现了典型的双后端问题：

- 业务 API 分散在 Python 和 Node.js 两套运行时中。
- 数据模型重复维护。
  `backend/hub/models.py` 使用 SQLAlchemy；
  `frontend/db/schema/*` 使用 Drizzle。
- 认证上下文分裂。
  `frontend` 使用 Supabase Session + Cookie；
  `backend` 主要使用 agent token / active agent 语义。
- 同一业务域已有两套实现。
  例如：
  `frontend/src/app/api/dashboard/overview/route.ts`
  和 `backend/hub/routers/dashboard.py`；
  `frontend/src/app/api/public/rooms/route.ts`
  和 `backend/hub/routers/public.py`。
- 测试与发布链路变复杂，问题定位成本高。

本次重构目标：

1. 将 `frontend` 中承担后端职责的 Node.js 服务收敛到 `backend` 中的新模块 `app`。
2. 保留 `backend/hub` 作为协议与 agent-facing 核心域。
3. 在 `backend` 内新增面向 Web / User Session 的业务层模块 `app`，作为统一的 Web API 服务。
4. 让 `frontend` 退化为纯前端 UI + 极薄代理，最终不再承载核心业务写逻辑。
5. 消除双 ORM schema 漂移风险，统一数据访问与业务约束实现。

## 2. 当前状态评估

### 2.1 backend 现状

`backend/hub` 当前已经具备较完整的业务领域：

- 路由：
  `registry`、`contacts`、`contact_requests`、`hub`、`room`、`topics`、`files`、`wallet`、`stripe`、`subscriptions`、`dashboard`、`public`
- 领域模型：
  `Agent`、`Room`、`RoomMember`、`MessageRecord`、`Contact`、`ContactRequest`、`Wallet*`、`Subscription*`
- 运行时：
  FastAPI + SQLAlchemy Async + Postgres

说明 `backend` 并不是“从零补一个 Web API”，而是已经拥有大部分底层能力，只是 Web 用户会话层还留在 `frontend`。

### 2.2 frontend 现状

`frontend/src/app/api` 下共有 `46` 个 `route.ts`，其中大量路由直接访问数据库、Stripe、Supabase，会被部署为 Node.js 服务端逻辑，而不是纯 UI 辅助层。

主要路由族如下：

- `dashboard/*`
- `public/*`
- `users/me*`
- `wallet/*`
- `subscriptions/*`
- `share/*`
- `stats/*`
- `auth/callback/route.ts`

### 2.3 frontend 中的后端职责分类

#### A. 用户会话与身份绑定层

- `src/lib/auth.ts`
- `src/lib/require-agent.ts`
- `src/lib/supabase/server.ts`
- `src/app/auth/callback/route.ts`
- `src/app/api/users/me/route.ts`
- `src/app/api/users/me/agents/*`

职责：

- 读取 Supabase Session
- 将登录用户映射到本地 `users`
- 校验 `X-Active-Agent`
- 处理 agent claim / bind / bind-ticket

#### B. 业务聚合 API

- `src/app/api/dashboard/*`
- `src/app/api/public/*`
- `src/app/api/share/*`
- `src/app/api/stats/route.ts`

职责：

- Dashboard overview 聚合
- Public rooms / agents 浏览
- room messages 公开/成员视角分流
- contact request 管理
- join room / share room

#### C. 金融与订阅业务

- `src/app/api/wallet/*`
- `src/app/api/subscriptions/*`
- `src/lib/services/wallet.ts`
- `src/lib/services/subscriptions.ts`
- `src/lib/services/stripe.ts`

职责：

- 钱包查询、转账、提现、流水
- Stripe checkout session
- topup fulfill
- 订阅商品、订阅者、取消、归档、订阅资格

#### D. 直接数据库访问层

- `frontend/db/*`
- `frontend/drizzle/*`

职责：

- Drizzle schema
- 迁移 SQL
- DB function 部署

### 2.4 重构核心问题

真正要合并的不是“frontend 的 API 文件”，而是以下 4 类能力：

1. Web 用户会话认证能力
2. 面向用户界面的 BFF/业务聚合能力
3. 钱包/Stripe/订阅等业务服务能力
4. Drizzle schema 与 SQLAlchemy model 的重复数据定义

## 3. 重构总体思路

### 3.1 目标边界

重构后建议形成如下职责划分：

- `backend/hub`
  保留协议核心、agent-facing API、消息投递、底层领域能力。
- `backend/app`
  新增面向 Web / Frontend / Supabase Session 的应用层 API。
- `frontend`
  仅保留页面、组件、状态管理、浏览器端 API client。
  可短期保留少量代理路由，长期尽量清空 `src/app/api`。

### 3.2 为什么不是直接把所有逻辑塞回 hub

不建议把所有前端 Node API 直接继续堆进 `hub/routers/*`，原因如下：

- `hub` 语义偏协议层，不适合继续承载用户会话和 Web BFF。
- `hub.auth` 当前偏 agent token / dashboard agent 认证，不适合直接混入 Supabase Session、cookie、浏览器登录态。
- 将 Web app 层独立为 `backend/app`，有利于明确边界：
  `hub = core domain + protocol`
  `app = user session + web api + bff aggregation`

### 3.3 目标目录建议

建议在 `backend` 下新增：

```text
backend/
  app/
    __init__.py
    main.py
    config.py
    database.py
    auth/
      __init__.py
      supabase.py
      session.py
      active_agent.py
    deps/
      __init__.py
      auth.py
      db.py
    routers/
      __init__.py
      auth.py
      users.py
      agents.py
      dashboard.py
      public.py
      wallet.py
      subscriptions.py
      share.py
      stats.py
    schemas/
      __init__.py
      users.py
      dashboard.py
      public.py
      wallet.py
      subscriptions.py
      share.py
    services/
      __init__.py
      users.py
      agents.py
      dashboard.py
      public.py
      wallet.py
      stripe.py
      subscriptions.py
      share.py
    repositories/
      __init__.py
      users.py
      agents.py
      rooms.py
      contacts.py
      wallet.py
      subscriptions.py
      messages.py
    security/
      __init__.py
      jwt.py
      permissions.py
```

说明：

- `routers` 控 HTTP 输入输出与状态码。
- `services` 放业务编排。
- `repositories` 放 SQLAlchemy 查询与事务操作。
- `schemas` 放 Pydantic request/response model。
- `auth/deps` 专门处理 Supabase session 与 active agent。

## 4. 认证与会话设计

### 4.1 当前问题

`frontend` 里用户认证依赖 Supabase SSR Cookie：

- `createServerClient(...)`
- `supabase.auth.getUser()`
- `exchangeCodeForSession(code)`

这套逻辑运行在 Next.js server runtime 中。迁入 Python 后，不能再复用 Next 的 cookie helper。

### 4.2 推荐方案

采用“Frontend 持续负责 Supabase 登录页面与浏览器 Cookie 生命周期，Backend App 负责校验 Supabase Access Token”的模式。

目标形式：

- 浏览器仍通过 Supabase 完成 OAuth 登录。
- `frontend` 拿到 session 后，请求 `backend/app` 时转发 `Authorization: Bearer <supabase_access_token>`。
- `backend/app` 使用 Supabase JWKS 或官方 introspection 方式校验 JWT。
- `backend/app` 基于 `sub` 查本地 `users.supabase_user_id`，得到平台用户。
- `X-Active-Agent` 仍作为显式上下文头，由 `backend/app` 校验该 agent 是否归属于当前 user。

### 4.3 不推荐方案

不推荐把 Supabase SSR cookie 读取逻辑照搬到 FastAPI。

原因：

- Next SSR cookie 机制与 Python 服务不天然兼容。
- 双端都写 cookie/session 刷新逻辑，维护成本高。
- Web API 更适合显式 Bearer token 模式。

### 4.4 过渡方案

重构初期可保留：

- `frontend` 继续负责 `auth/callback`
- `frontend` API client 在调用 `backend/app` 时自动注入 access token

待稳定后可选做法：

- 将 OAuth callback 也迁移到 `backend/app`
- 或继续保留在 `frontend`，仅作为前端登录入口

建议本轮不优先迁移 callback，先迁核心业务 API。

## 5. 数据层重构设计

### 5.1 当前问题

当前存在两套数据定义：

- `backend/hub/models.py`: SQLAlchemy models
- `frontend/db/schema/*`: Drizzle schema

这会带来：

- 字段变更需要双写
- 枚举可能漂移
- 约束和默认值可能不一致
- 迁移责任不清

### 5.2 推荐目标

以后由 `backend` 作为唯一后端 schema source of truth：

- 模型定义统一在 SQLAlchemy
- 迁移统一在 `backend/migrations`
- `frontend/drizzle` 停止继续承载主业务 schema 维护

### 5.3 迁移方式建议

分两步走：

#### 第一步：读写逻辑统一

- 先把 `frontend/src/app/api` 的业务读写迁到 `backend/app`
- `frontend/db/*` 暂时保留，供过渡期少量逻辑使用
- 所有新增 schema 变更一律只进 `backend`

#### 第二步：彻底退役 Drizzle schema

- 删除 `frontend/db/schema/*`
- 删除 `frontend/drizzle/*`
- 删除依赖 Drizzle 的服务逻辑
- 前端仅通过 HTTP 调 `backend/app`

### 5.4 DB Functions 的处理

当前 `frontend/db/functions/*` 中存在：

- `get_agent_room_previews`
- `get_public_room_previews`

建议：

- 这些 SQL function 迁到 `backend/migrations`
- 由 backend migration 统一部署
- 在 `backend/app` 中决定是否继续调用 SQL function
  或改写成 SQLAlchemy / SQL 查询

推荐保留 SQL function 一段时间，先减少迁移风险。

## 6. 路由迁移策略

### 6.1 总体原则

优先迁移“Node 专属业务逻辑”，避免重复维护。

迁移优先级建议：

1. `users/me*`
2. `dashboard/*`
3. `wallet/*`
4. `subscriptions/*`
5. `public/*`
6. `share/*`
7. `stats/*`

### 6.2 路由映射建议

建议在 `backend/app` 中保留接近现有前端 API 的路径语义，降低前端改造成本。

示例：

- `GET /api/users/me`
  -> `backend/app/routers/users.py`
- `GET /api/dashboard/overview`
  -> `backend/app/routers/dashboard.py`
- `GET /api/public/rooms`
  -> `backend/app/routers/public.py`
- `GET /api/wallet/summary`
  -> `backend/app/routers/wallet.py`
- `POST /api/wallet/stripe/checkout-session`
  -> `backend/app/routers/wallet.py`
- `GET /api/subscriptions/products`
  -> `backend/app/routers/subscriptions.py`

这样前端只需把 base URL 从 Next 本地 `/api/...` 切到 backend `/api/...`。

### 6.3 哪些路由应保留在 frontend

建议短期保留：

- `src/app/auth/callback/route.ts`
  原因是它紧贴 Supabase SSR 登录流。

建议中长期评估后再决定：

- 是否把 callback 迁到 backend
- 是否保留少量 edge/runtime 专属代理

### 6.4 哪些路由可以直接删除而不迁

若 backend/hub 已有功能且语义足够接近，可直接让 frontend 改调 hub/app 新接口，而不是机械复制原 Node route。

例如：

- `public/*`
- `dashboard/*`

其中有些已经在 `hub` 中具备对应实现，但需要统一鉴权与返回结构。

## 7. app 与 hub 的关系设计

### 7.1 推荐关系

`app` 不直接复制 `hub` 全部逻辑，而是：

- 对外提供 Web API
- 内部复用 `hub` 的 model、database、service 能力
- 必要时通过 service/repository 调用共享领域逻辑

### 7.2 共享方式建议

优先共享以下能力：

- `hub.models`
- `hub.database`
- `hub.enums`
- `hub.id_generators`
- `hub.services.wallet`
- `hub.services.subscriptions`
- `hub.services.stripe_topup`

若现有 `hub` service 粒度不合适，再逐步抽出到共享层，例如：

```text
backend/core/
  models/
  services/
  repositories/
```

但本轮不建议先做大规模分层重构，否则任务会过大。

### 7.3 app 不应做的事

`app` 不应通过 HTTP 再去调用本地 `hub` API。

应避免：

- `app -> http://localhost:8000/hub/...`

应采用：

- `app -> shared database session`
- `app -> shared python services`

否则只是把进程内调用变成低效的自调用，且事务无法统一。

## 8. 推荐分阶段实施方案

## Phase 0: 基线与冻结

目标：

- 明确迁移清单
- 冻结 frontend API 的新增需求
- 统一接口契约

步骤：

1. 盘点 `frontend/src/app/api` 全部 46 个路由，按领域分组。
2. 建立接口契约文档，冻结 request/response 字段。
3. 标记已有 `hub` 等价接口与差异项。
4. 约定以后新增业务接口只加到 `backend`。

交付物：

- 路由迁移矩阵
- 接口兼容清单

## Phase 1: 搭建 backend/app 骨架

目标：

- 在不迁业务前先把 `app` 基础设施搭起来。

步骤：

1. 新建 `backend/app` 目录结构。
2. 提供 `app.main:app`。
3. 复用 `hub.database`、配置日志、CORS、异常处理。
4. 建立 `require_user`、`require_active_agent` 依赖。
5. 接入 Supabase JWT 校验。
6. 增加基础健康检查和 `/api/users/me` 样板路由。

交付物：

- `backend/app/main.py`
- `backend/app/auth/*`
- `backend/app/routers/users.py`
- 基础测试框架

## Phase 2: 先迁身份与 agent 绑定

目标：

- 先统一用户与 active agent 上下文，再迁业务 API。

步骤：

1. 迁移 `users/me`
2. 迁移 `users/me/agents`
3. 迁移 `users/me/agents/[agentId]`
4. 迁移 `users/me/agents/bind-ticket`
5. 迁移 `users/me/agents/claim/resolve`
6. 迁移 `users/me/agents/bind`

说明：

- 这一阶段完成后，前端与 backend/app 的“用户 -> agent”上下文闭环就建立了。
- `bind` 中对 Hub registry 的 agent 控制权校验可继续保留，但逻辑应迁入 Python service。

风险点：

- `bind_ticket` 的格式与签名兼容
- 老 agent token 存储与过期语义兼容

## Phase 3: 迁 Dashboard 与 Public 聚合

目标：

- 去掉最主要的 BFF 路由。

步骤：

1. 迁移 `dashboard/overview`
2. 迁移 `dashboard/contact-requests/*`
3. 迁移 `dashboard/agents/search`
4. 迁移 `dashboard/agents/[agentId]`
5. 迁移 `dashboard/agents/[agentId]/conversations`
6. 迁移 `dashboard/rooms/discover`
7. 迁移 `dashboard/rooms/[roomId]/join`
8. 迁移 `dashboard/rooms/[roomId]/messages`
9. 迁移 `dashboard/rooms/[roomId]/share`
10. 迁移 `public/*`
11. 迁移 `share/[shareId]`
12. 迁移 `stats`

实施建议：

- 先保持现有 JSON 结构兼容，不做字段美化。
- 若 `hub` 已有类似实现，优先抽共享 service，而不是复制 SQL。
- 对 `_room-messages.ts` 这类查询逻辑，迁成 `repositories/messages.py`。

## Phase 4: 迁 Wallet / Stripe / Subscriptions

目标：

- 消除 Node.js 运行时上的支付和账务逻辑。

步骤：

1. 迁移 `wallet/summary`
2. 迁移 `wallet/ledger`
3. 迁移 `wallet/topups`
4. 迁移 `wallet/transfers`
5. 迁移 `wallet/withdrawals`
6. 迁移 `wallet/withdrawals/[withdrawalId]/cancel`
7. 迁移 `wallet/transactions/[txId]`
8. 迁移 `wallet/stripe/packages`
9. 迁移 `wallet/stripe/checkout-session`
10. 迁移 `wallet/stripe/session-status`
11. 迁移 `subscriptions/*`

实施建议：

- 先把 `frontend/src/lib/services/stripe.ts` 迁成 `backend/app/services/stripe.py`
- 尽量复用现有 `hub` 钱包与订阅服务
- 所有财务相关操作必须补事务测试和幂等测试

风险点：

- Stripe SDK 切换后参数名、异常类型不同
- 金额字段类型在 TS 与 Python 间转换差异
- 幂等键和重复回调处理必须重新验证

## Phase 5: 前端切换与 Node API 下线

目标：

- 让 frontend 从“带后端的 Next 应用”变成“纯前端”。

步骤：

1. `frontend/src/lib/api.ts` 改为直接请求 `backend/app`
2. 将 access token 注入 API client
3. 页面逐步从 `/api/...` 切到 backend base URL
4. 删除已迁移的 `src/app/api/*`
5. 删除 `frontend/db/*`
6. 删除 `frontend/drizzle/*`
7. 清理 `postgres`、`drizzle-orm`、`stripe` 的前端服务端依赖

完成标志：

- `frontend/src/app/api` 只剩 auth callback 或完全清空
- 生产部署不再需要 Node API 承载核心业务

## 9. 推荐执行顺序

建议按“最少切面风险”推进，而不是按文件数量推进。

### 第 1 批

- `users/me`
- `users/me/agents`
- `users/me/agents/[agentId]`
- `users/me/agents/claim/resolve`

原因：

- 读多写少
- 业务边界明确
- 可先打通 user/session/agent 基础依赖

### 第 2 批

- `dashboard/overview`
- `dashboard/agents/*`
- `dashboard/contact-requests/*`
- `public/*`
- `stats`

原因：

- 价值高
- 主要是读接口和轻写接口
- 有助于快速削减 BFF 体积

### 第 3 批

- `dashboard/rooms/*`
- `share/*`

原因：

- 需要处理消息查询、权限、分页、公开回退
- 比普通列表接口复杂

### 第 4 批

- `wallet/*`
- `subscriptions/*`
- `users/me/agents/bind`
- `users/me/agents/bind-ticket`

原因：

- 财务和 agent bind 风险最高
- 涉及外部系统、事务、幂等、签名/票据

## 10. 技术实施细节

### 10.1 后端入口设计

有两种可选方案。

#### 方案 A：独立 FastAPI app

- `backend/hub/main.py`
- `backend/app/main.py`

优点：

- 边界清楚
- 部署与路由命名独立

缺点：

- 本地和生产可能要维护两个 app 入口

#### 方案 B：单 FastAPI 主应用挂载两个 router 域

- 在 `hub/main.py` 中 `include_router(app_router, prefix="/api")`
- `hub/*` 继续保留原有路径

优点：

- 部署最简单
- 共享中间件与 lifespan

缺点：

- “hub”和“app”的物理目录分开，但运行时仍是一个 FastAPI app

本项目建议优先采用方案 B。

原因：

- 现有 `backend` 已有统一 DB、任务、配置、异常处理中枢
- 改动小，切流简单
- 对 frontend 来说只需要切 base URL 和 path

### 10.2 认证依赖建议

建议新增依赖函数：

- `get_current_user_from_bearer_token`
- `require_user`
- `require_active_agent`

职责：

- 校验 Supabase JWT
- 加载本地 user 记录
- 校验 `X-Active-Agent`
- 返回统一上下文对象，例如：

```python
class RequestContext(BaseModel):
    user_id: UUID
    supabase_user_id: str
    active_agent_id: str | None
    roles: list[str]
```

### 10.3 Service 层建议

避免在 router 中直接写大量 SQLAlchemy 逻辑。

建议模式：

- router:
  参数解析、鉴权、错误转换、response model
- service:
  业务编排、事务边界、跨 repository 组合
- repository:
  查询、insert、update、lock

### 10.4 错误模型建议

现在 `frontend` 多数返回：

```json
{ "error": "..." }
```

`backend/hub` 多数返回：

```json
{ "detail": "...", "retryable": false }
```

建议 `backend/app` 先兼容前端现有消费方式，统一成：

```json
{
  "error": "message",
  "code": "optional_machine_code"
}
```

或在 app 层统一包一层错误转换，避免前端一次性大改。

### 10.5 测试策略

backend 新增测试应覆盖：

- 认证：
  Supabase token 校验、active agent 校验
- 读接口：
  overview、public rooms、users/me
- 写接口：
  join room、contact request、bind、share
- 财务：
  checkout session、topup fulfill、withdraw cancel、subscribe/cancel

建议测试分层：

- `backend/tests/app/test_users.py`
- `backend/tests/app/test_dashboard.py`
- `backend/tests/app/test_public.py`
- `backend/tests/app/test_wallet.py`
- `backend/tests/app/test_subscriptions.py`
- `backend/tests/app/test_agents.py`

同时保留前端集成测试，但逐步把断言目标从 Next route 改成 API client / UI 行为。

## 11. 风险清单

### 高风险

- Supabase session 从 Next SSR 迁到 backend bearer 校验后，前端请求头若未正确注入，会出现整站 401。
- Stripe 支付与 topup fulfill 迁移时，幂等和重复记账风险高。
- `frontend` 与 `backend` 对同一张表的枚举/默认值理解不一致，迁移阶段可能出现脏数据。

### 中风险

- `hub` 已有 dashboard/public 实现，与 frontend 当前 JSON 结构不完全一致，容易引入前端兼容问题。
- 共享 SQL function 若迁移顺序不对，可能导致 overview/public 页面回归。
- `users/me/agents/bind` 依赖 registry 校验 agent token 控制权，跨模块迁移容易漏边界条件。

### 低风险

- `stats`、`public/overview` 这类读接口迁移难度较低。
- `users/me` 基础资料接口迁移难度较低。

## 12. 回滚策略

采用双写不可取，推荐双路由切换：

1. `backend/app` 新接口先上线，但前端默认仍调旧 Next API。
2. 前端增加环境变量开关，例如 `NEXT_PUBLIC_USE_BACKEND_APP_API=true`。
3. 小流量切换到新 backend/app。
4. 观察：
   认证错误率、5xx、支付成功率、join room 成功率、dashboard 首屏耗时。
5. 若异常，前端切回旧 Next API。

这样能避免数据库双写一致性问题。

## 13. 建议工期

按 1 名主程、1 名协作者的常规节奏估算：

- Phase 0: 1 到 2 天
- Phase 1: 2 到 3 天
- Phase 2: 2 到 4 天
- Phase 3: 4 到 6 天
- Phase 4: 5 到 8 天
- Phase 5: 2 到 4 天

总计：

- 保守估算 3 到 5 周

如果只做“先把大部分 Node API 去掉，不立刻删除 Drizzle 与 callback”：

- 可压到 2 到 3 周

## 14. 推荐近期执行计划

### Week 1

- 完成路由迁移矩阵
- 建立 `backend/app` 骨架
- 打通 Supabase bearer 校验
- 迁移 `users/me` 与 `users/me/agents*` 的低风险接口

### Week 2

- 迁移 `dashboard/overview`
- 迁移 `dashboard/contact-requests/*`
- 迁移 `dashboard/agents/*`
- 迁移 `public/*`
- 前端 API client 支持切到 backend/app

### Week 3

- 迁移 `dashboard/rooms/*`
- 迁移 `share/*`
- 把 room message 查询与 share 聚合彻底移出 Next route

### Week 4

- 迁移 `wallet/*`
- 迁移 `subscriptions/*`
- 补交易与支付回归测试
- 切默认流量到 backend/app

### Week 5

- 删除已废弃 `frontend/src/app/api/*`
- 删除 `frontend/db/*` 和 `frontend/drizzle/*`
- 清理依赖与部署配置
- 完成文档、运维脚本、回归测试

## 15. 我给你的最终建议

### 架构建议

本次不要做“大一统 backend 重写”，而是做“backend 内新增 `app` 模块，frontend 渐进退役 Node API”。

### 模块建议

优先采用：

- `backend/hub` 保持不动为核心域
- `backend/app` 新增 Web 用户会话与业务 API 层
- 单 FastAPI 主应用统一挂载

### 迁移策略建议

优先迁：

- 用户身份
- Dashboard / Public

后迁：

- Wallet / Stripe / Subscription / Bind

### 数据层建议

从这次重构开始，数据库 schema 与迁移的唯一事实来源应转移到 `backend`。

### 前端建议

前端尽量不要再新增任何需要直接访问 DB 的 `route.ts`。
以后新增业务接口只加到 `backend/app`。

## 16. 建议的第一批实际任务

如果下一步直接开工，我建议按下面顺序执行：

1. 在 `backend` 新增 `app` 骨架，并挂载到现有 FastAPI 主应用。
2. 实现 `require_user` 和 `require_active_agent`。
3. 迁移 `GET /api/users/me`。
4. 迁移 `GET /api/users/me/agents`。
5. 迁移 `GET /api/dashboard/overview`。
6. 让 `frontend/src/lib/api.ts` 支持请求新的 backend `/api`。
7. 用开关切换一小部分页面到新接口。

这个顺序能最快验证：

- 认证可行
- active agent 语义可行
- frontend 到 backend/app 的联通可行
- 共享 DB model 可行

