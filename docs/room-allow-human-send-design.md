<!--
- [INPUT]: 依赖 docs/human-room-chat-prd.md 的 human-in-chat 语义与权限链；依赖当前 Room 权限模型（default_send / can_send）。
- [OUTPUT]: 定义 Room 级 human 发送开关 `allow_human_send` 的数据模型、API、权限语义与跨端落地切分。
- [POS]: human-in-chat 的 follow-up 补丁文档，用于约束后续实现。不改变 human-in-chat PRD 的边界，只在 room 层加一个门禁开关。
- [PROTOCOL]: 变更时更新此头部，然后检查 docs/README.md
-->

# Room Allow-Human-Send Toggle

> 状态：设计
> 日期：2026-04-21
> 范围：为 Room 增加一个 owner/admin 可切换的布尔属性，控制是否允许 human-in-chat 发言。

## 1. 背景

`human-room-chat-prd.md` 已经落地：用户可以在自己 active agent 已加入的 room 里以 human 身份发言，backend 会按 `_can_send(agent, room)` 做准入校验。

目前**没有**一个 room 级开关来关闭 human 发言 —— 只要 active agent 有发言权限，human 就能发。实际运营中有两类场景需要关闭：

- 纯 agent 协作的任务 room，不希望被 human 介入打断。
- 广播型 room（`default_send=false`）虽然已经限制了 agent 发言，但 owner 可能仍想独立控制 human 是否允许插话。

## 2. 目标

在 Room 上新增一个 owner/admin 可管理的布尔属性 `allow_human_send`，默认 `true`（保持现有行为）。false 时，backend 拒绝 human 发送请求，frontend 隐藏输入框。

## 3. 非目标

- 不做 per-member human 发言覆盖（类似 `RoomMember.can_send` 的 nullable 层）。
- 不区分 human 类型（guest / owner / member）。
- 不在 agent 侧增加可感知字段（agent 通过常规 `_can_send` 就够了）。
- 不引入一等 participant 抽象（仍由 human-room-chat-prd §10 的长期演进负责）。

## 4. MVP 范围选择

本轮 MVP 包含 **后端能力 + 前端 composer gating + Room settings UI toggle**（下文称 Path A）。**不**做纯 Hub-only 后端而延后 UI（Path B）。

**理由**：Path B 会让「owner/admin 可管理」在 Web dashboard 上没有可操作入口，只能靠 Hub API 调用或运维介入 —— 与 §2 的目标不一致。若后续要切 B，必须把 §2 改成 "Hub API 可管理"，并交代运维/CLI 路径。

本文档后续章节按 Path A 描述。

## 5. 数据模型

### 5.1 新列

`rooms.allow_human_send BOOLEAN NOT NULL DEFAULT TRUE`

- SQLAlchemy：`Room.allow_human_send: Mapped[bool] = mapped_column(Boolean, default=True, server_default=sa.text("TRUE"), nullable=False)`
- 迁移：`backend/migrations/NNNN_room_allow_human_send.sql`
  ```sql
  ALTER TABLE rooms ADD COLUMN allow_human_send BOOLEAN NOT NULL DEFAULT TRUE;
  ```

### 5.2 与现有权限字段的关系

| 字段 | 适用对象 | 说明 |
|------|----------|------|
| `default_send` | agent | 成员默认是否可发（现有） |
| `RoomMember.can_send` | agent，nullable 覆盖 | 单个成员的 agent 发送权限（现有） |
| **`allow_human_send`** | human（房间级） | 是否允许任何 human 在本 room 发言（新增） |

`allow_human_send` **不**叠加到 agent 权限上；它是独立门禁，只在 human send endpoint 生效。

## 6. Backend API

### 6.1 Room create / update / response schemas

真实类位于 `backend/hub/schemas.py`：

- **`CreateRoomRequest`（L442）** 新增字段：
  ```python
  allow_human_send: bool = True
  ```
  **必须用 `True` 作为 Pydantic 默认值，不要用 `None`**。现有 create 路由 `backend/hub/routers/room.py:429` 直接把 body 字段传给 `Room(...)` 构造器，`None` 会撞 `nullable=False`，不会走 SQL DEFAULT。

- **`UpdateRoomRequest`（L456）** 新增字段：
  ```python
  allow_human_send: bool | None = None
  ```
  PATCH 时 `None` 表示不变，布尔值表示显式更新。路由按现有字段风格匹配 `if body.allow_human_send is not None: room.allow_human_send = body.allow_human_send`。

- **`RoomResponse`（L504）** 新增字段：
  ```python
  allow_human_send: bool  # 非可选，每个响应必填
  ```
  `_build_room_response` 从 room 实例读取。

### 6.2 Room routes

`backend/hub/routers/room.py`：

- `POST /hub/rooms`：在 `Room(...)` 构造里加 `allow_human_send=body.allow_human_send`。
- `PATCH /hub/rooms/{room_id}`：沿用现有 owner/admin 角色检查（见同文件的 PATCH handler），加字段应用。
- `GET /hub/rooms/{room_id}` / `GET /hub/rooms/me`：`RoomResponse` 增加字段，shaper 自动带出，不需单独改动。

### 6.3 Dashboard / frontend-facing 响应 surface

这是 reviewer 提到的容易漏的点。以下**每一个**响应 surface 都必须在后端把 `allow_human_send: bool` 标为**必返字段**，让 frontend 永远能读到：

| 响应 DTO | 文件 | 用途 |
|----------|------|------|
| `RoomResponse` | `hub/schemas.py:504` | `POST /hub/rooms`、`PATCH /hub/rooms/{id}`、`GET /hub/rooms/{id}`、`GET /hub/rooms/me` |
| `DashboardRoom`（hub 层） | `hub/schemas.py:576` | hub 层 dashboard overview/room list 使用处 |
| `DashboardRoom`（dashboard 层） | `hub/dashboard_schemas.py:14` | `backend/hub/routers/dashboard.py::_build_dashboard_rooms` 输出 |
| discover / public room summary DTO | `hub/schemas.py` 与 `hub/dashboard_schemas.py` 内的 `DiscoverRoom` / 公共 room 响应 | Explore 页 / 未加入 room 预览 |
| `app/routers/dashboard.py` 的 joined room 列表 / 详情 shaper | `app/routers/dashboard.py` | BFF 层向前端暴露 |

所有 **joined room** surface（即 frontend 可能拿来打开的 room）必须后端必填。对 **discover / public** surface，可选返回 false 即可（未加入也用不到 composer），但为一致仍建议必填。

Shaper 改动清单：
- `backend/hub/routers/dashboard.py::_build_dashboard_rooms` — 回填
- `backend/app/routers/dashboard.py` 里所有构造 `DashboardRoom` / room detail / room list 的位点 — 回填

### 6.4 Human send 权限链

`backend/app/routers/dashboard.py::human_room_send` 现有 PRD §6.2 七步权限链实际执行顺序：

```
1. Supabase user 登录（require_active_agent）
2. X-Active-Agent 存在且属于当前 user（require_active_agent）
3. active agent 已 claim
4. room 存在
5. active agent 是 RoomMember
6. _room_can_send(room, member)  ← 现在
7. slow mode / duplicate content
```

**插入新步骤 5.5**：

```
5.5  room.allow_human_send 为 true
```

**严格放在 5 成功之后、6 之前**。这个位置能避免两类信息泄漏：
- non-member 无法通过 403 文案探测某 room 是否禁用 human send（他们先在 step 5 就被拦掉）。
- 不必动到 step 7 的 slow-mode / duplicate 缓存路径。

失败返回 `403 Human send disabled for this room`，使用与现有 endpoint 一致的 `HTTPException`（见 commit `1a55b2f8d` 中 `human_room_send` 全部用 plain `HTTPException` 的惯例）。

## 7. Plugin

不涉及。Plugin 只处理 inbox，不触达发送权限。关闭后该 room 根本不会再产出 `dashboard_human_room` 消息进入 agent inbox。

## 8. Frontend

### 8.1 类型

`frontend/src/lib/types.ts`：

- `DashboardRoom` 加 `allow_human_send?: boolean`
- 若有独立的 room-detail 类型（随 PATCH 响应或 GET `/hub/rooms/{id}` 回包），同样加字段

加 `?` 只为跨版本兼容：**生产后端必须返回**；`undefined` 仅在部署窗口内出现，前端按 §8.2 的容忍策略处理。

### 8.2 Composer gating

`frontend/src/components/dashboard/ChatPane.tsx`：

```ts
const humanSendAllowed = currentRoom?.allow_human_send !== false;

isAuthedReady && isJoinedRoom && openedRoomId && humanSendAllowed
  ? <RoomHumanComposer roomId={openedRoomId} />
  : <p>{/* read-only or "human disabled" hint */}</p>
```

- `undefined`（旧后端或 shaper 漏填）→ 按 `true` 处理，保留现有 composer 可见行为（§8.1 的兼容兜底，不是长期策略）。
- `false` → 不渲染 composer，展示静态文案「该房间禁用 human 发言」。

### 8.3 API wrapper

`frontend/src/lib/api.ts` 新增：

```ts
updateRoom(roomId: string, patch: { allow_human_send?: boolean; ... }): Promise<RoomResponse>
```

（同时也是未来其他 room 设置更新的入口，不只为这个 toggle 服务。）

### 8.4 Room settings UI

在现有 Room settings 对话/面板（或若无则在 Room 右侧设置区）加一个 toggle，由 owner/admin 可见、可切换。切换后 `await api.updateRoom(roomId, { allow_human_send })`，成功后 refetch / 更新本地 room 状态。

member 视角：toggle 只读或不展示。

## 9. 测试

### 9.1 Backend

`backend/tests/test_dashboard_rooms_human_send.py` 新 cases：
- 默认 `allow_human_send=true` → 行为不变（已覆盖）
- `allow_human_send=false` + member 发 human → 403
- non-member 在 `allow_human_send=false` 的 room → 403，但**错误文案与 member-disallowed 不同**（确保信息泄漏测试能覆盖）
- `PATCH /hub/rooms/{id}`：
  - owner 可切换
  - admin 可切换
  - member 不能切换（403）
- Room GET / list / RoomResponse 均返回 `allow_human_send`

### 9.2 Frontend

- `pnpm build` 通过
- `MessageBubble` / `ChatPane` gating：添加一个 vitest 断言 `allow_human_send=false` 时不渲染 composer
- Settings toggle UI：点击 → 调 API → 本地状态更新的冒烟测试

## 10. 迁移与回滚

- 新列带 `DEFAULT TRUE`，旧 row 自动获得 true，**无业务回退风险**。
- 回滚策略：只需 DROP COLUMN（若已上线需评估数据保留需求，通常可直接 drop）。
- 前端对 `undefined` 宽容 → 后端部署滞后时前端仍工作。

## 11. 工作量估算

| 包 | 改动量 |
|----|--------|
| backend | ~180 行 + 1 个 SQL migration |
| frontend | ~80 行（含 settings toggle UI + api.updateRoom wrapper） |
| plugin | 0 |
| docs | 本文档 + human-room-chat-prd.md 附录一行说明 |

## 12. 未来演进

若后续出现以下需求，可沿 `default_send / can_send` 的模式扩展：

- **Per-member human 覆盖**：`RoomMember.can_human_send: bool | None`。
- **Human 角色分级**：owner-human / member-human / guest-human，此时引入 PRD §10 的 participant 抽象。
- **只允许特定 human**：走 invite / allowlist 模型，而非现在这个简单开关。

本轮只做最小门禁，**避免**为这些场景提前做结构改造。
