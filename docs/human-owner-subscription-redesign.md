# Human-as-owner: subscription products + room admin

> 状态: 设计稿 v2.1 (评审反馈收敛)
> 范围: backend (schema + service + auth) + frontend (RoomSettingsModal)
> 前置: `docs/room-subscription-redesign.md` (PR #352, 已合并)
> 日期: 2026-04-27

## 修订记录

**v2.1 (二轮评审反馈修复)**:
- migration 031 `owner_type` 从 `VARCHAR(16)` 改为复用既有 `participanttype` Postgres enum (与 migration 024 / `Room.owner_type` 一致；DB 层有合法值约束) — §3.2.1
- `viewer_can_admin_room` 的 `RoomMember` admin fallback 显式加 `participant_type == ParticipantType.agent` 过滤，不再仅靠 ID 前缀做区分 — §3.4

**v2 (一轮评审反馈修复)** — 解决 v1 的 6 个问题：
1. `provider_agent_id` 不再依赖 `X-Active-Agent` (human 路径根本不发) — 改成 body 必填 + `Agent.user_id == ctx.user_id` 校验 (§3.4 / §3.5 / §7)
2. `PATCH /api/dashboard/rooms/{id}` 不能只换 owner-only 鉴权：路由前置 `RoomMember.agent_id == active_agent` 会先把 human 挡掉。改成切 `require_user_with_optional_agent` + `viewer_can_admin_room` 返回 `"owner"|"admin"|None` 分级 (§3.4 / §3.5)
3. `PATCH /api/humans/me/rooms/{id}` (humans BFF) 也直接赋值 `required_subscription_product_id` 无校验 — 同 PR #352 §5.7 的安全洞，PR A 必须一起堵 (§3.5 / PR A scope)
4. `DELETE /hub/rooms/{id}` 是 agent claim auth，没有 `ctx.user_id` — 不能 "同上" 复用 helper。新增 `DELETE /api/dashboard/rooms/{id}` BFF 路由，hub 路由保留 agent-only (§3.5)
5. `subscription_products.owner_agent_id` 不能 "兼容留一阵" — `list_*` / `archive_*` / `_product_response` / dashboard 校验都读它，human-owned 产品会瞬间不可管理。PR A 必须把所有读路径切到 `(owner_id, owner_type)` (§5 PR A scope)
6. `RoomSettingsModal` 没有 `room.owner_id` / `owner_type` props，没法决定显示「收款 bot」下拉 — PR B 要补 props + 所有调用点 (§3.6 / PR B scope)

## 1. 背景与问题

PR #352 落地后暴露两个 UX/权限问题：

1. **`POST /api/subscriptions/products` 强制 `X-Active-Agent`**
   订阅产品 schema 是 agent-only (`subscription_products.owner_agent_id` 是 agent 外键)，但 dashboard 里很多场景下用户是以 Human 身份操作 (e.g. 自己创建的房间，owner 是 hu_*)，浏览器请求没带 `X-Active-Agent`，直接 400。

2. **`migrate-plan` / room owner 校验只认 `active_agent_id == room.owner_id`**
   `room.owner_id` 在 migration 024 后已经是 polymorphic (`ag_*` 或 `hu_*`)。一个 human 用户可以拥有多个 agent，那些 agent 当 room owner 的房间，human 在不切到那个 agent 的情况下应该也能改设置 (它们终归是这个用户的资产)。当前实现要求 viewer 严格切到 owner agent，UX 很别扭。

## 2. 设计目标

| # | 目标 |
|---|------|
| G1 | Human 可以创建/拥有订阅产品 |
| G2 | Human 可以管理 (改价 / 关停 / 解散) 自己 bot 当 owner 的房间，不需要切身份 |
| G3 | 钱流暂不变 — 转账 from/to 仍只支持 agent-as-recipient (人钱包通路本期不做) |
| G4 | Schema 改动一次到位，避免反复 migration |
| G5 | 既有 agent-owned 数据零迁移成本 |

## 3. 设计

### 3.1 一句话

> Subscription product 加 polymorphic owner，钱流仍走 agent；room owner 鉴权改为「viewer 是 room.owner_id 本人 OR viewer 是 room.owner agent 的所属 user」。

### 3.2 Schema 改动 (migration 031)

#### 3.2.1 `subscription_products`

参照 `rooms` (migration 024) 的 polymorphic 写法：

```sql
-- owner_type reuses the existing `participanttype` Postgres enum created
-- by migration 024 (rooms / contacts / blocks). Stay consistent with
-- Room.owner_type so SQLAlchemy `Enum(ParticipantType, name="participanttype")`
-- maps cleanly, and the DB enforces legal values at the column level.
ALTER TABLE subscription_products
    ADD COLUMN owner_id VARCHAR(64),
    ADD COLUMN owner_type participanttype,
    ADD COLUMN provider_agent_id VARCHAR(32) REFERENCES agents(agent_id);

-- Backfill: agent-owned products' owner_agent_id remains the source of truth
UPDATE subscription_products
SET owner_id = owner_agent_id,
    owner_type = 'agent',
    provider_agent_id = owner_agent_id
WHERE owner_id IS NULL;

ALTER TABLE subscription_products
    ALTER COLUMN owner_id SET NOT NULL,
    ALTER COLUMN owner_type SET NOT NULL,
    ALTER COLUMN provider_agent_id SET NOT NULL;

-- Drop the old uniqueness constraint, add a polymorphic version
ALTER TABLE subscription_products DROP CONSTRAINT uq_subscription_product_owner_name;
ALTER TABLE subscription_products
    ADD CONSTRAINT uq_subscription_product_owner_name UNIQUE (owner_id, owner_type, name);

CREATE INDEX ix_subscription_products_owner ON subscription_products(owner_id, owner_type);
CREATE INDEX ix_subscription_products_provider ON subscription_products(provider_agent_id);

-- owner_agent_id retained as a deprecated read-only mirror (NULLable from now on)
-- to keep old code paths reading agents-only products non-broken during rollout.
ALTER TABLE subscription_products ALTER COLUMN owner_agent_id DROP NOT NULL;
```

**字段含义**:

| 列 | 语义 |
|---|---|
| `owner_id` + `owner_type` | 谁能管理这个产品 (改价 / 归档)。可以是 hu_* 或 ag_* |
| `provider_agent_id` | 钱打到哪个 agent 的钱包。**永远是 agent**。当 owner 是 human 时，前端创建产品时必须指定 (一般是该 human 的某个 bound agent) |
| `owner_agent_id` (deprecated) | 兼容旧代码用，新代码读 `owner_id`/`owner_type` |

#### 3.2.2 `agent_subscriptions` 不动

`provider_agent_id` 已经是 agent (= `subscription_products.provider_agent_id` 的快照)。继续。

`subscriber_agent_id` 不动 — 订阅者本期仍只支持 agent (human 订阅是另一个独立设计 §6)。

### 3.3 Service 层

```python
# backend/hub/services/subscriptions.py

async def create_subscription_product(
    session,
    *,
    owner_id: str,
    owner_type: ParticipantType,
    provider_agent_id: str,  # 新增必填
    name: str,
    description: str = "",
    amount_minor: int,
    billing_interval: BillingInterval,
    asset_code: str = "COIN",
) -> SubscriptionProduct:
    if owner_type == ParticipantType.human and provider_agent_id is None:
        raise ValueError("Human-owned products must specify a provider_agent_id")
    if owner_type == ParticipantType.agent and provider_agent_id != owner_id:
        # invariant: agent-owned products always have themselves as provider
        raise ValueError("Agent-owned product provider must be the owner agent")
    ...
```

`_charge_subscription` 已经按 `subscription.provider_agent_id` 转账，不需要改。

### 3.4 鉴权 helper

新加 `app/auth_room.py`:

```python
async def viewer_can_admin_room(
    db: AsyncSession,
    ctx: RequestContext,
    room: Room,
) -> Literal["owner", "admin", None]:
    """Return the strongest capability the JWT viewer has on this room.

    "owner" — viewer can do owner-only ops (visibility, plan, dissolve, ...)
    "admin" — viewer is a RoomMember with role admin (can edit basics only)
    None    — no admin/owner capability

    Owner-cap cases:
    - viewer is acting AS the owner agent (X-Active-Agent == room.owner_id)
    - room is human-owned and viewer.human_id == room.owner_id
    - room is agent-owned and that agent's user_id == ctx.user_id
      (transitive — viewer's user owns the bot that owns the room)

    Admin-cap: the legacy RoomMember.role == 'admin' check, scoped to the
    viewer's active agent. Humans don't get admin via membership today.
    """
    # Owner cases first
    if room.owner_type == ParticipantType.agent:
        if ctx.active_agent_id and ctx.active_agent_id == room.owner_id:
            return "owner"
        agent = (await db.execute(
            select(Agent).where(Agent.agent_id == room.owner_id)
        )).scalar_one_or_none()
        if agent is not None and agent.user_id == ctx.user_id:
            return "owner"
    elif room.owner_type == ParticipantType.human:
        if ctx.human_id and ctx.human_id == room.owner_id:
            return "owner"

    # Admin via RoomMember (agent path only — preserve current behavior).
    # Filter on participant_type=agent explicitly: RoomMember is polymorphic
    # since migration 024, and ID prefixes alone shouldn't be relied on as
    # a discriminator inside auth code.
    if ctx.active_agent_id:
        member = (await db.execute(
            select(RoomMember).where(
                RoomMember.room_id == room.room_id,
                RoomMember.agent_id == ctx.active_agent_id,
                RoomMember.participant_type == ParticipantType.agent,
            )
        )).scalar_one_or_none()
        if member and member.role in (RoomRole.owner, RoomRole.admin):
            return "owner" if member.role == RoomRole.owner else "admin"

    return None


async def resolve_provider_agent_for_room(
    db: AsyncSession,
    ctx: RequestContext,
    room: Room,
    *,
    requested_provider_agent_id: str | None,
) -> str:
    """Pick the agent that should receive subscription payments for this room.

    - room is agent-owned → the owner agent (request body field is ignored)
    - room is human-owned → REQUIRES request body to specify
      `provider_agent_id`, which must be an active agent owned by ctx.user.
      We do NOT fall back to X-Active-Agent — the human path doesn't send it.
    """
    if room.owner_type == ParticipantType.agent:
        return room.owner_id
    if not requested_provider_agent_id:
        raise HTTPException(
            status_code=400,
            detail="provider_agent_id is required for human-owned rooms",
        )
    agent = (await db.execute(
        select(Agent).where(Agent.agent_id == requested_provider_agent_id)
    )).scalar_one_or_none()
    if agent is None or agent.user_id != ctx.user_id:
        raise HTTPException(
            status_code=403,
            detail="Provider agent does not belong to this user",
        )
    if agent.status != "active":
        raise HTTPException(status_code=400, detail="Provider agent is not active")
    return requested_provider_agent_id
```

### 3.5 端点改动

**鉴权依赖一律切到 `require_user_with_optional_agent`** (Supabase JWT 必填，
`X-Active-Agent` 可选)，再用 `viewer_can_admin_room` 做能力分级。这样
human identity 下 (没发 `X-Active-Agent`) 也能通过 `room.owner_type=='human'` 或
`agent.user_id == ctx.user_id` 这两条路径拿到 `owner` 能力。

| 端点 | 改动 |
|---|---|
| `POST /api/subscriptions/products` | 仍 require_active_agent — 跨房间通行证 self-serve 路径，agent 视角创建 |
| `POST /api/dashboard/rooms/{id}/subscription/migrate-plan` | 切到 `require_user_with_optional_agent`；要 `viewer_can_admin_room == "owner"`；body 新增可选 `provider_agent_id`；human-owned room 必填，按 `resolve_provider_agent_for_room` 校验；agent-owned 忽略 |
| `PATCH /api/dashboard/rooms/{id}` (dashboard.py) | 切到 `require_user_with_optional_agent`；先算 `cap = viewer_can_admin_room`；fields 分两组：基础字段 (`name/description/rule`) 要 `cap in {owner, admin}`，owner-only 字段 (`visibility / join_policy / default_send / default_invite / max_members / slow_mode_seconds / required_subscription_product_id`) 要 `cap == "owner"`。**特别**：`required_subscription_product_id` 仍要走 §5.7 PR #352 的产品有效性 + ownership 校验，但 ownership 改成 `product.owner_id == room.owner_id AND product.owner_type == room.owner_type` |
| `PATCH /api/humans/me/rooms/{id}` (humans.py BFF) | **新增同样的校验**：(a) 沿用既有 human-as-owner 鉴权；(b) `required_subscription_product_id` 字段加产品存在 / active / ownership 校验，并在 clear 时做 §3.6 的 legacy `room_id` backfill (与 dashboard PATCH 一致)。这是 PR #352 的同类型缺口，必须一起堵 |
| `DELETE /api/dashboard/rooms/{id}` (新增 BFF) | 新建 BFF dissolve 路由，复用 `viewer_can_admin_room == "owner"` 鉴权 + PR #352 已落地的 pre-cancel 订阅逻辑。前端从此调这个，不再调 hub |
| `DELETE /hub/rooms/{id}` (hub agent JWT) | 保持不变 — agent claim auth，agent-token 持有人 == 当前 owner agent 才能解散；human 通路走新增的 BFF 端点 |
| `POST /api/dashboard/rooms/{id}/leave` 等 member-only | 不变 |

### 3.6 Frontend

**`RoomSettingsModal`**:

- **加 props**：调用方必须传 `roomOwnerId: string` 和 `roomOwnerType: "human" | "agent"`，否则没法决定要不要显示 provider agent 下拉。所有调用点都要补 (chat 列表 / discover / explore card / 其它能打开 modal 的位置)。备选：如果 props 改动面太大，modal mount 时 fetch 一次 `GET /api/dashboard/rooms/{id}` 拿 owner metadata。**倾向 props**，已有数据复用避免多一次请求
- **删 first-time-enable 两步分支** (`createSubscriptionProduct + PATCH room`) — 一律 `migrate-plan`，原子，没有 `X-Active-Agent` 歧义
- **human-owned 房间**：订阅区出现「收款 bot」下拉
  - 数据：`api.getMyAgents()`，过滤 `status == "active"`
  - 默认值：viewer 当前 active_agent (若属于此 user)，否则首个 active agent
  - 选中后 `migrateRoomSubscriptionPlan` body 带 `provider_agent_id`
- **agent-owned 但 viewer 没切到该 agent**：订阅区可编辑 (新鉴权放行)，不再硬要求切身份
- **dissolve 按钮**：human 模式下也调用新的 `DELETE /api/dashboard/rooms/{id}` (不再依赖 hub agent JWT 路径)

`migrate-plan` body schema:

```typescript
migrateRoomSubscriptionPlan(roomId, {
  amount_minor: "1000",
  billing_interval: "week",
  provider_agent_id?: string,  // human-owned 必填，agent-owned 忽略
})
```

## 4. 与已合并 PR 的兼容

- 现有 agent-owned 产品：migration 031 backfill 把 `owner_id = owner_agent_id, owner_type='agent', provider_agent_id = owner_agent_id`，行为不变
- PR #352 的 `room_id` 反查路径 / mismatch cancel：完全不受影响
- PR #352 frontend 的 `upsertRoomPlan` 两步分支：删除，改为一律 migrate-plan

## 5. 任务拆分

为了方便 review，建议两个 PR 并行 + 一个串联收尾：

### PR A — Backend schema + service + auth (规模较大)

**Schema / model**
- [ ] migration 031: `subscription_products` polymorphic owner (`owner_id` + `owner_type`) + 新增 `provider_agent_id` + backfill (`owner_id=owner_agent_id, owner_type='agent', provider_agent_id=owner_agent_id`)
- [ ] `SubscriptionProduct` model 加 `owner_id` / `owner_type` / `provider_agent_id`；`owner_agent_id` 列**保留但全部代码不再读**（PR C 收尾删列）

**Service 层 — 全量切到 owner_id/owner_type 读路径** (Finding 5)
- [ ] `create_subscription_product(owner_id, owner_type, provider_agent_id, ...)` 新签名
- [ ] `list_subscription_products(owner_id=, owner_type=)` 改按 polymorphic 过滤
- [ ] `archive_subscription_product` 的 `owner_agent_id == current_agent` 校验 → 改为按 owner_id+owner_type
- [ ] `_product_response` 改返回 `owner_id` / `owner_type` 字段（也保留 `owner_agent_id` 老字段做向后兼容 — 老前端读老字段不报错；human-owned 时该字段为 NULL）
- [ ] `_product_query` / 其它内部 helper 同步迁移
- [ ] dashboard 的「product 必须属于 room owner」校验改为对比 `(owner_id, owner_type)`
- [ ] migrate-plan 归档老 product 的逻辑：human-owned product 的归档不能依赖 `current_agent` 校验，改用 polymorphic owner 比对

**Auth helpers**
- [ ] 新建 `app/auth_room.py`：`viewer_can_admin_room` (返回 `"owner"|"admin"|None`) + `resolve_provider_agent_for_room` (从 body 读，不依赖 X-Active-Agent — Finding 1)

**端点鉴权改造**
- [ ] `POST /api/dashboard/rooms/{id}/subscription/migrate-plan`: 切 `require_user_with_optional_agent` + `viewer_can_admin_room == "owner"` + body 加 `provider_agent_id`
- [ ] `PATCH /api/dashboard/rooms/{id}`: 切 `require_user_with_optional_agent` + 拆「基础字段 admin/owner」/「owner-only 字段 owner」两套门 (Finding 2)
- [ ] `PATCH /api/humans/me/rooms/{id}` (humans.py BFF): **补齐** `required_subscription_product_id` 校验 (产品存在 / active / 属于 room owner) + clear-paid 的 legacy room_id backfill (Finding 3) — 与 dashboard PATCH 行为一致
- [ ] **新增** `DELETE /api/dashboard/rooms/{id}` (BFF): 鉴权 = `viewer_can_admin_room == "owner"`，复用 PR #352 的 pre-cancel 订阅逻辑 (Finding 4)
- [ ] `DELETE /hub/rooms/{id}`: **不动** — 保留 agent-token-only 语义，human 走 BFF 新路由

**单测**
- [ ] human-owned room: human 直接改价 (不切 identity) → 200
- [ ] agent-owned room: human-as-bound-user 改价 (不切 identity) → 200
- [ ] agent-owned room: 跨用户 (非 owner、非 bound) 改价 → 403
- [ ] human-owned room: migrate-plan 不带 `provider_agent_id` → 400
- [ ] human-owned room: `provider_agent_id` 不属于 ctx.user → 403
- [ ] human BFF PATCH 设置无效 product_id → 404；非 owner 的 product → 403 (Finding 3 回归)
- [ ] human BFF dissolve via 新 BFF 路由 → 订阅被 pre-cancel
- [ ] hub `DELETE /rooms/{id}` agent-token (持有 owner agent token) → 200 (现有行为不破)

### PR B — Frontend (依赖 A)
- [ ] `RoomSettingsModal` props 新增 `roomOwnerId: string` + `roomOwnerType: "human" | "agent"`，**所有调用点都补齐** (Finding 6)：
  - `frontend/src/components/dashboard/ChatHeader*` / `RoomHeader*` (打开 modal 的入口)
  - 任何其它打开 modal 的地方 — 在 PR 描述里枚举确认
  - 数据来源：chat store 的 room 对象已经有 `owner_id` / `owner_type` 字段 (后端已下发)，直接透传
- [ ] `migrateRoomSubscriptionPlan` 签名加可选 `provider_agent_id`
- [ ] `useDashboardSubscriptionStore.upsertRoomPlan` 删 first-time 两步分支，一律 `migrateRoomSubscriptionPlan`
- [ ] `RoomSettingsModal`：
  - human-owned room → 显示「收款 bot」下拉，必选；调用 migrate-plan 时带 `provider_agent_id`
  - agent-owned room → 不再因 active agent 不匹配而锁订阅区
  - dissolve 按钮调用新的 `DELETE /api/dashboard/rooms/{id}` (而不是 hub)
- [ ] i18n: "收款机器人" / "Receiving bot" 文案 (en + zh)
- [ ] 防御性：如果 `roomOwnerType` 缺失，订阅区显示「需要刷新」提示而不是猜，避免误把 human 当 agent 处理

### PR C — 收尾 (依赖 A+B 都合)
- [ ] 删除 `SubscriptionProduct.owner_agent_id` 列 (migration 032)
- [ ] 任何残留 `owner_agent_id` 引用清理

## 6. 不在本期范围

- **Human 作为订阅者**: `agent_subscriptions.subscriber_agent_id` 仍 agent-only。Human 自己刷卡订阅是另一个设计 (要先打通 human 钱包 → human → agent 转账)
- **Human-owned 产品的钱进 human 钱包**: 本期 provider 必须是 agent (= human 的某个 bot)
- **跨用户产品共管**: 一个产品仍恰好一个 owner

## 7. 待确认 (v2 收敛后)

- [ ] PR A/B 并行 (用户已确认 §1)，PR C 收尾删 `owner_agent_id` 列
- [x] 前端 human-owned 强制让用户显式选 provider bot — 静默用 active agent 易踩雷 (一旦 active 不在该 user 名下就 403)，且本期 active agent 在 human 模式下根本不发
- [ ] **新待确认**：humansApi PATCH 是否要支持 `required_subscription_product_id` 字段？历史上能写但没校验。如果业务上允许 human 直接挂别人的产品到自己房间，那是 bug；否则就严校验。**倾向**：严校验 (与 dashboard PATCH 对齐)
- [ ] **新待确认**：hub `DELETE /rooms/{id}` 是否最终也想删？目前各 daemon / agent CLI 还在用。**倾向**：保留，只是 frontend 不再调它

## 8. 参考

- `docs/room-subscription-redesign.md` — 上一轮设计 (PR #352)
- migration 024 (`backend/migrations/024_human_participant.sql`) — polymorphic owner 模式参考
- `backend/hub/models.py:64` Agent 模型 (`user_id` 是关键字段)
- `backend/hub/models.py:958` User 模型 (`human_id` 关键字段)
- `backend/app/auth.py:33` RequestContext 已经同时持有 `user_id`/`human_id`/`active_agent_id`
