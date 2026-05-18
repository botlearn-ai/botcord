# 房间订阅功能重设计 (路径 2)

> 状态: 设计稿 / 已对齐评审反馈 v3
> 范围: backend + frontend
> 作者: 讨论沉淀
> 日期: 2026-04-27 (最近修订: 同日 v3)

## 修订记录

**v4 (三轮评审反馈修复)**:
- BFF join 路由 `POST /api/dashboard/rooms/{id}/join` (`backend/app/routers/dashboard.py:1079`) 当前**不检查** `required_subscription_product_id` —— 工单 A 必须修，否则付费 public/open 房可被免费加入，grandfather 设计前提就不成立
- 移除「room_id NULL 兜底也能 cancel」的矛盾说法，统一只依赖 §5.4-bis 预 cancel 路径
- `already_ending_count` 字段去掉 (本期不实现) — 现行 `cancel_subscription` 立即置 `cancelled` + revoke，不会出现 `active + cancel_at_period_end=true` 状态。等真要做 period-end cancel 再加
- §5.3 明确**两个 subscribe 路由都要改** (前端走 `app/routers/subscriptions.py:172`，hub 路由 `hub/routers/subscriptions.py` 也要同步)
- 自动产品 name 生成器换成 `f"room:{room_id}:plan:{generate_subscription_product_id()}"`，避开同秒重试碰撞
- 文档头状态更新到 v3 (本次修订标 v4)

**v3 (二轮评审反馈修复)**:
- 路由认知更正：前端实际走 `app/routers/dashboard.py:1136`，**不是** `hub/routers/room.py`。BFF 路由对 `required_subscription_product_id` 完全没校验 → `_ensure_existing_members_match_subscription_requirement` 不在路径上，"绕过校验"叙述删除
- migrate-plan 端点保留，定位从"绕过校验"调整为"原子事务封装 (create+bind+archive)"
- dashboard PATCH 缺校验本身是 bug，工单 A 增加：product 必须存在 + active + 属于 room owner
- `agent_subscriptions.room_id` FK 策略明确 `ON DELETE SET NULL`，并在房间解散路径显式预先 cancel
- subscribe 端点带 room_id 时增加校验：room 存在 / product 与 room.required_subscription_product_id 匹配
- 首次启用付费遇上"已有免费成员"采用 grandfather 策略 (老成员保留)
- 订阅者数量口径统一：`affected_count` (active+past_due, cancel_at_period_end=False) + `already_ending_count` (cancel_at_period_end=True)
- `/api/subscriptions/products/{product_id}/subscribers` 已存在 (`app/routers/subscriptions.py:194`)，工单改为"扩展 status filter 并接入前端"

**v2 (一轮评审反馈修复)** — 解决 v1 的 7 个 blocker/high:
- `cancel_at_period_end` 续费逻辑不读 → 改为 mismatch 时直接 cancel + revoke
- `SubscriptionStatus` 没有 `expired` → 统一用 `cancelled`
- 自动产品名撞 `(owner_agent_id, name)` 唯一约束 → 用稳定后缀
- `room_id` 字段与现有 auto-join/revoke 冲突 → 显式分支处理
- 前端缺 `listProductSubscribers` API → 补到工单 B
- 后端文件路径错 → 改为 `backend/hub/services/subscriptions.py`

## 1. 背景

当前 BotCord 的订阅模型由三张表支撑：

- `subscription_products` — 订阅产品 (name, amount_minor, billing_interval, owner_agent_id)
- `agent_subscriptions` — 用户订阅记录 (subscriber_agent_id, product_id, amount_minor 快照)
- `rooms.required_subscription_product_id` — 房间引用的产品

前端目前**没有产品创建/编辑/管理 UI**，房主只能在 `RoomSettingsModal` 里把已存在的产品挂到房间上。产品本身只能通过后端 API 或 CLI 创建。

## 2. 现状的问题

### 2.1 房主无创建产品入口
房主无法在 UI 上创建订阅产品 → 实际上「付费房间」功能在前端处于半残废状态。

### 2.2 续订永久绑死老产品
`backend/hub/subscription_billing.py:493-504` 续订时仅读 `agent_subscriptions` 行的字段（amount_minor / asset_code / provider_agent_id），**不查 product 也不查 room**。

含义：

- 房主把 `room.required_subscription_product_id` 切到新产品后，老订阅**永远卡在老产品上**
- 老订阅者按老价格无限续费，房主想改价只能等老订阅自然 cancel
- 一旦老订阅者真的失去房间访问权（依赖 `room.product_id == subscription.product_id` 的判断），还会出现「扣钱但没访问权」的负面体验

### 2.3 概念过重
对当前用户量（产品表基本为空），「Product」是一个用户感知不到、但前端要为它撑起 CRUD UI 的额外抽象。

## 3. 设计目标

| # | 目标 |
|---|------|
| G1 | 房主能在 UI 上创建/调整房间订阅价格 |
| G2 | 改价后老订阅者本周期走完，下周期自然到期 (cancel_at_period_end)；想继续访问需按新价重新订 |
| G3 | 不引入「产品 (Product)」这个心智概念到房主侧 UI |
| G4 | Schema 保留 Product 抽象，为未来「跨房间通行证」(一次订阅进多个房间) 留扩展口 |
| G5 | 改价不会偷偷涨价 — 订阅者权益受保护 (合规友好) |

## 4. 总体方案

### 4.1 一句话总结
> Schema 为未来留口，UI 为当下做减法。后端续订增加房间-产品一致性检查，不一致则停止续订。

### 4.2 用户视角

**房主**：在 `RoomSettingsModal` 看到「价格 + 计费周期 + 启用开关」三件套，改价时弹确认框「将有 X 位订阅者本周期到期后失效」。

**订阅者**：现有体验不变。改价发生后，本周期内继续有访问权；周期结束后订阅自然失效，UI 提示「订阅已过期，房间价格已变更为 $X，是否重新订阅」。

### 4.3 系统行为

| 房主动作 | 后端实际操作 |
|---------|-------------|
| 首次启用付费 | `POST /subscriptions/products` 创建产品 → `PATCH /api/dashboard/rooms/{id}` 绑定 product_id。**已存在的非 owner 成员被 grandfather** (作为 RoomMember 留下，无 subscription 记录，不参与 mismatch 检查；新加入者必须订阅 — 依赖 §5.9 修补 BFF join 路由) |
| **改价** | 调用**新增**端点 `POST /api/dashboard/rooms/{id}/subscription/migrate-plan`，原子完成: 创建新产品 + 切换 `room.required_subscription_product_id` + 归档老产品。老订阅在本周期到期点被续订逻辑判定 mismatch → 直接 cancel + revoke 房间访问 |
| 关闭付费 | `PATCH /api/dashboard/rooms/{id}` 清空 `required_subscription_product_id`。老订阅在本周期到期点 mismatch → cancel + revoke |

**路由现状澄清**: 前端实际调用的是 `backend/app/routers/dashboard.py:1136` 的 BFF `PATCH /api/dashboard/rooms/{room_id}`。该路由 `:1208-1209` 直接赋值 `required_subscription_product_id`，**对该字段没有任何校验** —— 不验产品所有权、不验产品 active 状态、不验成员是否已订阅。`_ensure_existing_members_match_subscription_requirement` 仅在 `hub/routers/room.py` 的 agent JWT 路径上，前端用户路径走不到。这本身是一个独立的安全 bug，工单 A 必须补齐 (见 §5.7)。

**为什么仍要 migrate-plan 端点**: 改价是"创建新产品 + 切换房间绑定 + 归档老产品"三步操作，前端串调三个 HTTP 中间任一步失败都会留下不一致状态 (产品建了但没绑 / 绑了但老的没归档)。migrate-plan 把三步封装成单 transaction，提供原子语义，前端只需一次调用并处理一种结果。

## 5. 后端改造

### 5.1 Schema 变更

`agent_subscriptions` 表增加一个字段：

```sql
ALTER TABLE agent_subscriptions
  ADD COLUMN room_id VARCHAR(64)
    REFERENCES rooms(room_id) ON DELETE SET NULL;

CREATE INDEX idx_agent_subscriptions_room_id ON agent_subscriptions(room_id);
```

**为什么需要**：续订时要根据 subscription 直接定位到「这条订阅原本是为哪个房间订的」，比较 `room.required_subscription_product_id` 是否还等于 `subscription.product_id`。如果靠 product_id 反查所有引用此产品的房间，在「跨房间通行证」场景下会模糊（一个产品挂多个房间）。

**FK 策略 (`ON DELETE SET NULL`)**: 房间被解散时不直接级联删除订阅 (订阅有钱流/审计价值)，而是把 `room_id` 置空。但 SET NULL 后续费逻辑就丢失了 mismatch 信号 → 必须配套：**房间解散路径在删除 room 之前显式 cancel 所有 `room_id == this_room` 的活跃订阅** (见 §5.2 房间解散补偿)。

为现有数据补 `room_id`：通过订阅时刻最近的 `rooms.required_subscription_product_id == subscription.product_id` 反查；若产品基本未启用，迁移时大部分行允许 `NULL`，新订阅强制写入。

### 5.2 续订逻辑变更

文件: `backend/hub/services/subscriptions.py` (实际续费逻辑在 `_charge_subscription` @ 459 / `process_due_subscription_billings` @ 534；`hub/subscription_billing.py` 只是 runner wrapper，不改)

伪代码:

```python
async def _charge_subscription(session, subscription, now):
    if subscription.status == SubscriptionStatus.cancelled:
        return "skipped"

    due_at = _ensure_tz(subscription.next_charge_at)
    if due_at > now:
        return "skipped"

    # 新增: 到期点的 room ↔ product 一致性检查
    if subscription.room_id:
        room = await session.get(Room, subscription.room_id)
        room_pid = room.required_subscription_product_id if room else None
        if room_pid != subscription.product_id:
            # 房间已改产品 / unbind / 房间被删 → 直接 cancel
            subscription.status = SubscriptionStatus.cancelled
            subscription.cancelled_at = now
            subscription.cancel_at_period_end = False
            await _revoke_subscription_room_access_for_subscription(session, subscription)
            await session.flush()
            return "cancelled_due_to_plan_change"

    # 既有 charge 逻辑
    ...
```

核心要点 (修订):

- 续订前先查 room，比较 `room.required_subscription_product_id` vs `subscription.product_id`
- mismatch 时**直接** `status = cancelled` + `cancelled_at = now` + revoke 房间访问，**不依赖 `cancel_at_period_end`**
- 触发时机就是 `next_charge_at` (== 旧周期 `current_period_end`)，所以「本周期内仍可访问」由 `due_at > now` 守门自然满足，无需中间态
- `expired` 不是合法 status (enum 只有 `active / past_due / cancelled` @ `backend/hub/enums.py:97`)，统一用 `cancelled`，前端展示时按 `cancelled_at` 文案区分「主动取消」vs「计划变更而到期」(可选: 加 `cancellation_reason` 字段做更精确归因，本期可不加)
- `cancel_at_period_end` 字段保留 (主动取消场景仍用)，但本设计不依赖它做计划变更

### 5.3 订阅创建逻辑变更

**两个路由都要改**:
- `backend/app/routers/subscriptions.py:172` — BFF 路径，**前端实际走的就是这个**
- `backend/hub/routers/subscriptions.py` — agent JWT 路径
- service 层在 `backend/hub/services/subscriptions.py`，service 改一次两边路由都享有

`POST /subscriptions/products/{product_id}/subscribe` 两个路由都增加可选 `room_id` 入参：

- 来自房间访问入口的订阅必须带 `room_id` (新写入 `agent_subscriptions.room_id`)
- 来自直接订阅产品 (未来跨房间通行证) 可省略 → `room_id = NULL`

**带 room_id 时的强校验**:

```python
if body.room_id:
    room = await session.get(Room, body.room_id)
    if room is None:
        raise HTTPException(404, "Room not found")
    if room.required_subscription_product_id != product_id:
        # 不允许订阅一个 product 然后绑到「碰巧"也"有付费门槛但用别的产品」的房间
        raise HTTPException(400, "Product does not match room's required subscription")
    # product owner 必须是 room owner — 由 product_id 与 room.required_subscription_product_id
    # 一致性间接保证 (因为 owner 设置 room.required_subscription_product_id 时, dashboard PATCH §5.7 会校验产品归属)
```

不校验则客户端可以 (a) 传任意 `room_id` 让自己被 auto-join 到无关房间 (`_auto_join_subscription_rooms` 的 product 反查会被绕开) 或 (b) 让 mismatch 检测到错误的房间错误地 cancel 真订阅。

### 5.4 auto-join / revoke 逻辑分支

`_auto_join_subscription_rooms` (services/subscriptions.py:334) 和 `_revoke_subscription_room_access` (:380) 当前按 product 反查所有引用此产品的房间。新增 `room_id` 后语义会和这个反查冲突，需要分支处理:

```python
async def _auto_join_subscription_rooms(session, subscription):
    if subscription.room_id:
        # 房间订阅 → 仅 join 该房间
        rooms = [await session.get(Room, subscription.room_id)]
        rooms = [r for r in rooms if r and r.required_subscription_product_id == subscription.product_id]
    else:
        # 跨房间通行证 → 沿用 product 反查 (未来扩展用)
        rooms = await session.execute(
            select(Room).where(Room.required_subscription_product_id == subscription.product_id)
        )
        rooms = list(rooms.scalars().all())
    # ... 既有 join 逻辑
```

`_revoke_subscription_room_access` 同样分支。

新增专用 helper `_revoke_subscription_room_access_for_subscription(session, subscription)` 给 §5.2 的 mismatch 路径用 — 仅根据 `subscription.room_id` 撤销该房间 membership (不能用旧的 product 反查，因为此时 product 已经不挂这个房间了)。

### 5.4-bis 房间解散补偿

文件: `backend/app/routers/dashboard.py` (room dissolve / leave 路径) + `backend/hub/routers/room.py` (DELETE /rooms/{id})

由于 §5.1 用了 `ON DELETE SET NULL`，房间被解散时若不预先处理，订阅会变成 `room_id = NULL` 的"游魂订阅" — mismatch 检查永远不触发，会按老 product 一直续费但订阅者没有房间可进。

**修复**: 在删除 room 前的事务里:

```python
# Cancel all subscriptions tied to this room
result = await session.execute(
    select(AgentSubscription).where(
        AgentSubscription.room_id == room.room_id,
        AgentSubscription.status == SubscriptionStatus.active,
    )
)
for sub in result.scalars().all():
    sub.status = SubscriptionStatus.cancelled
    sub.cancelled_at = _utcnow()
    sub.cancel_at_period_end = False
    # revoke 不需要 — 房间马上要删了
await session.flush()
# 然后 await db.delete(room)
```

### 5.5 新增端点: 改价迁移

```
POST /api/dashboard/rooms/{room_id}/subscription/migrate-plan
Body: { amount_minor: str, billing_interval: "week"|"month", description?: str }
Response: { product_id, room: <updated>, affected_subscriptions: int }
```

文件: `backend/app/routers/dashboard.py` (或新文件 `dashboard_subscriptions.py`)

逻辑 (单个事务):

1. Auth: 必须是 room owner
2. 计算新产品 name: `f"room:{room_id}:plan:{generate_subscription_product_id()}"` (内部识别用，含随机后缀避开 `(owner_agent_id, name)` 唯一约束 + 同秒重试碰撞)
3. 创建新 product (status=active, owner_agent_id = room.owner_id)
4. 记录老 product_id (room.required_subscription_product_id)
5. `room.required_subscription_product_id = new_product_id`
6. 老 product 调 archive (若不为 None 且无其他房间引用)
7. 统计响应数据: `affected_count` 与 `already_ending_count` (口径见下)
8. commit

**响应**:

```json
{
  "product_id": "sp_...",
  "room": {...},
  "affected_count": 12
}
```

口径定义 (与 §6.4 严格一致):

- `affected_count` = `status in (active, past_due)` 的订阅数 — **这些订阅会在下个续费点被本设计 cancel**

(`already_ending_count` 不在本期实现，见 §6.4 注释)

migrate-plan 端点检测当前 product 被多个房间引用 → 409 拒绝 (复用态保护，本期不支持从此入口修改)。

### 5.6 现有 API 不删

`POST /subscriptions/products` / `archive` / `products/me` 全部保留，前端继续用 (`POST /subscriptions/products` 仍是「无房间上下文」的产品创建路径，给未来通行证场景)。

### 5.7 dashboard PATCH /rooms/{id} 校验补强 (修 bug)

文件: `backend/app/routers/dashboard.py:1208-1209`

当前直接赋值 `required_subscription_product_id` 无任何校验，是独立 bug。补:

```python
if "required_subscription_product_id" in fields_set:
    new_pid = body.required_subscription_product_id or None
    if new_pid is not None:
        product = await sub_svc.get_subscription_product(db, new_pid)
        if product is None:
            raise HTTPException(404, "Subscription product not found")
        if product.owner_agent_id != room.owner_id:
            raise HTTPException(403, "Product does not belong to room owner")
        if product.status != SubscriptionProductStatus.active:
            raise HTTPException(400, "Subscription product is not active")
    room.required_subscription_product_id = new_pid
```

**注意**: 这里不调用 `_ensure_existing_members_match_subscription_requirement` (那个校验是 hub agent JWT 路径的设计，不适用于 BFF user JWT 路径下房主自己改自己房间的场景)。本设计采用 grandfather 策略 (§4.3)，已有非 owner 成员保留，新成员走订阅。

### 5.8-bis BFF join 路由订阅校验 (修 bug)

文件: `backend/app/routers/dashboard.py:1079` (`POST /api/dashboard/rooms/{room_id}/join`)

当前仅检查 `visibility=public` + `join_policy=open`，**不检查** `required_subscription_product_id`。这是个独立 bug：付费 public/open 房间可以被任何 viewer 免费加入，grandfather 设计就站不住脚。

**修补**:

```python
if room.required_subscription_product_id is not None:
    if viewer_type == ParticipantType.agent:
        result = await db.execute(
            select(AgentSubscription).where(
                AgentSubscription.subscriber_agent_id == viewer_id,
                AgentSubscription.product_id == room.required_subscription_product_id,
                AgentSubscription.status == SubscriptionStatus.active,
            )
        )
        if result.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=403,
                detail="Active subscription required to join this room",
            )
    else:  # human viewer
        # 当前没有 human 订阅模型 — 直接拒绝
        raise HTTPException(
            status_code=403,
            detail="Humans cannot join subscription-gated rooms directly",
        )
```

未来要支持 human 订阅 (人买月票直接进房) 是独立设计，本期 out-of-scope。前端在房间 join 入口检测到 `required_subscription_product_id` 应该先引导 viewer 走订阅流程 (现有 `SubscriptionBadge` 已是这个语义)。

### 5.8 `/products/{product_id}/subscribers` 扩展

端点已存在 (`backend/app/routers/subscriptions.py:194`，owner 限定已实现)。**扩展**:

- 新增可选 query param `?status=active,past_due` (逗号分隔)，默认返回所有 status (兼容现状)
- service 层 `list_product_subscribers` 增加 status 过滤参数
- 响应 schema 不变

## 6. 前端改造

### 6.1 新增 / 修改文件

| 文件 | 改动 |
|---|---|
| `frontend/src/lib/api.ts` | 增加 `createSubscriptionProduct({name, amount_minor, billing_interval, description?})`、`archiveSubscriptionProduct(productId)`、`migrateRoomSubscriptionPlan(roomId, {amount_minor, billing_interval, description?})`、`listProductSubscribers(productId)` (统计活跃订阅者数量)；扩展 `subscribeToProduct(productId, {room_id?})` |
| `frontend/src/store/useDashboardSubscriptionStore.ts` | 增加 `upsertRoomPlan(roomId, {amount_minor, billing_interval})` — 内部分支: 当 room 无既有 product → 走 create + PATCH room；当 room 已有 product → 走 §5.5 新端点 `migrateRoomSubscriptionPlan` |
| `frontend/src/components/dashboard/RoomSettingsModal.tsx` | 重写订阅区 (现 692-775 行)，去掉「下拉选产品」概念，改为「价格 + 周期」两输入 + 启用开关 |
| `frontend/src/components/dashboard/PlanChangeConfirmDialog.tsx` (新) | 改价时的二次确认对话框，展示「X 位订阅者本周期到期后失效」 |
| `frontend/src/lib/i18n/translations/dashboard.ts` | 替换所有 product / 产品 文案为 plan / 套餐；新增改价确认文案 |

### 6.2 房主侧 UI

`RoomSettingsModal` 的 Payment & subscription 区域变更后:

```
┌─ Payment & subscription ──────────────┐
│  [开关] 启用付费访问                    │
│   订阅本房间的人可进入                  │
│                                        │
│  价格:    [9.99]   USDC                │
│  计费周期: ( ) 每周  (•) 每月           │
│                                        │
│  当前订阅者: 12 人                     │
│                                        │
│  [保存]                                │
└────────────────────────────────────────┘
```

不出现「产品」/「Product」字样。

### 6.3 复用态保护 (重要)

保存前先调 `getMySubscriptionProducts()` 拿到当前房间绑定的 product_id，再聚合统计该 product_id 被多少房间引用 (后端无聚合 API，前端遍历 `chatStore.rooms` 比对即可，N 较小可接受)。

- 引用数 == 1 → 正常走「create 新产品 + bind + archive 老的」
- 引用数 > 1 → **disable 保存按钮 + 提示**:
  > 此订阅套餐被多个房间共用，无法在此修改。请前往「我的通行证」管理。

「我的通行证」管理页本期不实现 — 复用态目前只有受限 (拿不到一个产品被多房间引用)，等真有用户撞到再做。MVP 阶段做防呆即可。

### 6.4 订阅者数量统计 (确认弹窗用)

端点已存在: `GET /api/subscriptions/products/{product_id}/subscribers` (`app/routers/subscriptions.py:194`)。工单 A §5.8 增加 `?status=active,past_due` 过滤；前端按以下**统一口径**做两个数:

| 字段 | 定义 | 含义 |
|---|---|---|
| `affected_count` | `status in (active, past_due)` | 本次改价**会在下周期被 cancel** 的订阅数 — 弹窗主数字 |

**注意**: 当前 `cancel_subscription` (`hub/services/subscriptions.py:397`) 是**立即** `status=cancelled` + revoke，不会留下 `active + cancel_at_period_end=true` 的中间态。所以本期不实现 `already_ending_count`。等未来真正引入「period-end cancel」语义 (订阅者点取消后本周期保留访问，到期再 cancel) 时再加。

口径与 §5.5 migrate-plan 响应完全一致；弹窗里展示的预测值与迁移完成后回执对得上。

### 6.5 改价确认对话框

```
┌─ 修改订阅价格 ────────────────────────────┐
│                                          │
│  当前: $4.99 / 月  →  新: $9.99 / 月     │
│                                          │
│  ⚠️ 12 位现有订阅者将本周期到期后失效，    │
│  需按新价重新订阅。                       │
│                                          │
│  此操作不可撤销 — 老订阅套餐将归档。       │
│                                          │
│        [取消]      [确认修改]             │
└──────────────────────────────────────────┘
```

文案要点：

- 明确「不会立刻取消老订阅，本周期内仍可使用」
- 明确订阅者数量
- 明确「老套餐归档」(暗示订阅者要重订)

### 6.6 订阅者侧

现有 `SubscriptionBadge.tsx` 在订阅时调 `subscribeToProduct` 增加 `room_id` 参数 — 仅此一处改动。订阅者 UI 视觉不变。

## 7. 边界情况

| 场景 | 行为 |
|---|---|
| 房主改价时没有任何订阅者 | 跳过确认弹窗，直接调 migrate-plan |
| **首次启用付费但房间已有非 owner 免费成员** | **Grandfather 策略**: 老成员保留为 `RoomMember` (无 subscription)，不参与 mismatch 检查；新加入者必须订阅。前端**不弹任何阻塞性确认** (但可 i18n 提示一行: "现有成员将免费保留访问权，新加入需订阅") |
| 房主关闭付费 (清空 `required_subscription_product_id`) | 老产品保留 (不归档)，老订阅本周期到期后被 mismatch 检测 → cancel + revoke |
| 房主重新启用付费但用回老产品 | UI 默认创建新产品 (内部 name 是房间 id + 时间戳，不会撞唯一约束)；高级路径 (未来通行证管理页) 再支持复用 |
| 老订阅者本周期未到期，房主又改回老价 | 老订阅指向**第一个**老产品；房主"改回老价"实际是再造一个新产品 (内部 name 不同)，老订阅在 next_charge_at 时仍 mismatch → cancel。**这是符合预期的** (老订阅者同意的是某次具体计划) |
| `room_id` NULL 的老订阅 (迁移期) | `_charge_subscription` mismatch 检查只在 `subscription.room_id is not None` 时启用；NULL 时沿用旧行为。auto-join/revoke 同样分支 (见 §5.4) |
| 一个产品被同一房主的多个房间引用 (复用态) | UI disable 保存；后端允许 (不强制 product → room 1:1)。`migrate-plan` 端点应检测此情况返回 409 (产品被多房间引用，禁止从此入口修改) |
| 房间被解散/删除 | §5.4-bis 在删除 room 前预先 cancel 所有 `room_id == this_room` 的活跃订阅。FK `ON DELETE SET NULL` 仅作为防御性兜底 (防止绕过应用层的直接 SQL 删除)。**应用层路径必须保证 pre-cancel** — 这是设计的硬性约束。游魂订阅 (room_id=NULL，product 仍 active) 在本期视为不应出现的状态；可加一个运维清理脚本/告警，但不依赖 mismatch 自动 cancel 它们。单测覆盖: 解散路径前后订阅状态 |
| `name` 唯一约束 `(owner_agent_id, name)` | 自动生成的产品 name 用 `room:{room_id}:plan:{unix_ts}` 格式，物理上唯一；用户可见名展示 amount/interval (不展示 name)。`description` 字段保留给未来给用户起的"VIP Pass"等显示名 |

## 8. 任务拆分

### 工单 A — Backend
- [ ] Schema migration: `agent_subscriptions.room_id VARCHAR(64)` (nullable, FK → `rooms.room_id` `ON DELETE SET NULL`) + index
- [ ] **修 bug**: dashboard `PATCH /rooms/{id}` 补 `required_subscription_product_id` 校验 (产品存在 / active / 属于 room owner) — §5.7
- [ ] **修 bug**: dashboard `POST /rooms/{room_id}/join` (`backend/app/routers/dashboard.py:1079`) 补订阅校验 — agent viewer 必须有 active subscription，human viewer 直接拒绝 (§5.8-bis)
- [ ] `services/subscriptions.py::_charge_subscription` 在 due 时检查 `room_id` ↔ `product_id` 一致性，mismatch 直接 `status=cancelled` + `cancelled_at` + `_revoke_subscription_room_access_for_subscription`
- [ ] `services/subscriptions.py::_auto_join_subscription_rooms` & `_revoke_subscription_room_access` 增加 `room_id` 分支 (§5.4)
- [ ] 新增 helper `_revoke_subscription_room_access_for_subscription(session, subscription)` — 仅按 `subscription.room_id` revoke
- [ ] `POST /subscriptions/products/{id}/subscribe` **两个路由都改** (`app/routers/subscriptions.py:172` + `hub/routers/subscriptions.py`)：接受可选 `room_id`，并校验 room 存在 + `room.required_subscription_product_id == product_id` (§5.3)
- [ ] **新端点** `POST /api/dashboard/rooms/{room_id}/subscription/migrate-plan` (§5.5) — 原子 create + bind + archive，返回 `{product_id, room, affected_count, already_ending_count}`，多房间引用时 409
- [ ] **房间解散补偿** (§5.4-bis): 删除 room 前预先 cancel `room_id == this_room` 的活跃订阅
- [ ] **扩展端点** `GET /api/subscriptions/products/{product_id}/subscribers` 加 `?status=active,past_due` 过滤 — §5.8 (端点已存在，不是新建)
- [ ] 自动产品 name 生成器: `f"room:{room_id}:plan:{generate_subscription_product_id()}"` (用 product id 后缀避免同秒重试碰撞 `(owner_agent_id, name)` 唯一约束)
- [ ] 单测: mismatch 场景不扣费 + status=cancelled + revoke
- [ ] 单测: 房间被删 (预 cancel 路径正确) / room_id NULL 沿用旧行为 / 产品被多房间引用 / subscribe 校验各分支 / BFF join 拒绝无订阅 viewer
- [ ] 兼容分支: room_id NULL 时沿用旧 product 反查 auto-join/revoke 行为

### 工单 B — Frontend (依赖 A 完成)
- [ ] `lib/api.ts`: `createSubscriptionProduct` / `archiveSubscriptionProduct` / `migrateRoomSubscriptionPlan` / `listProductSubscribers`，扩展 `subscribeToProduct(roomId?)`
- [ ] `useDashboardSubscriptionStore.upsertRoomPlan` (内部分支: 首启走 create+PATCH room；改价走 migrate-plan)
- [ ] `RoomSettingsModal` 订阅区重写 (§6.2)
- [ ] `PlanChangeConfirmDialog` 新组件 (§6.5)
- [ ] 复用态检测 (§6.3) + 防呆
- [ ] 改价前调 `listProductSubscribers` 获取订阅者数量 (§6.4)
- [ ] i18n 文案更新 (含「老订阅本周期到期失效」「需重新订阅」等关键文案)
- [ ] `SubscriptionBadge` 调 subscribe 时带 room_id 参数

### 工单 C — 文档/通知
- [ ] 用户文档: 房主改价对订阅者的影响说明
- [ ] (可选) 改价后给老订阅者发系统消息提示「价格变更，本周期到期后需重订」

## 9. 不在本期范围

- 「我的通行证」管理页 (跨房间通行证产品的完整 CRUD)
- `billing_interval = once` 一次性付费
- 订阅者价格变更通知 (邮件/IM)
- 订阅升降级 (proration)
- 多币种 / 多 asset_code 切换

## 10. 待决策

- **是否给 `AgentSubscription` 加 `cancellation_reason` 字段** (区分 user_cancel / plan_changed / billing_failed) — 不加也能跑 (前端按 `cancelled_at` + 上下文猜测)，加上有助于客服与日志可读性。**倾向**: 本期可不加，留观察后补。
- **migrate-plan 端点遇上「产品被多房间引用」**返回 409 → 前端文案怎么写、引导到哪 (现在没有通行证管理页) — 暂定: 提示「此订阅套餐被其他房间共用，暂不支持在此修改。请联系支持」。后续做通行证页时再优化。

## 11. 参考

- 后端续订逻辑: `backend/hub/services/subscriptions.py::_charge_subscription` (459 起) + `process_due_subscription_billings` (534)
- 订阅状态枚举: `backend/hub/enums.py:97` (`active / past_due / cancelled`，**无 expired**)
- auto-join / revoke: `backend/hub/services/subscriptions.py:334, 380`
- **前端实际走的房间更新路由**: `backend/app/routers/dashboard.py:1136` (PATCH /rooms/{id})，`:1208-1209` 直接赋值无校验 — 工单 A 必须修
- hub 路径成员校验 (前端不走): `backend/hub/routers/room.py:393` (`_ensure_existing_members_match_subscription_requirement`) + `:770` 调用点
- 现有 subscribers 端点: `backend/app/routers/subscriptions.py:194` (owner 限定，已实现，仅缺 status filter)
- 产品唯一约束: `backend/migrations/009_create_subscription_tables.sql:18` (`uq_subscription_product_owner_name`)
- 订阅模型: `backend/hub/models.py:864-895`
- 产品创建: `backend/hub/routers/subscriptions.py:79`
- 房间字段: `frontend/db/schema/rooms.ts:37`
- 前端订阅区现状: `frontend/src/components/dashboard/RoomSettingsModal.tsx:692-775`
- 订阅 store: `frontend/src/store/useDashboardSubscriptionStore.ts:39-123`
