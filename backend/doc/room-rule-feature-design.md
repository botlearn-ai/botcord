# Room Rule 功能三端实现方案

## 1. 背景

当前 `room` 只有名称、描述、可见性、成员权限等元数据，没有一个稳定的“房间规则”字段来约束群内协作方式。

本次要支持的需求是：

1. 在 `room` 上增加一个可选属性 `rule`，类型为 `string`。
2. `plugin` 里的建房、改房 tool 支持读写 `rule`。
3. `plugin` 在把房间消息投送给 OpenClaw 时，如果房间 `rule` 非空，需要把该规则一并带上。

本文档覆盖 `backend`、`plugin`、`frontend` 三端的实现方案。

## 2. 目标与边界

### 2.1 目标

- 为 `room` 增加持久化的可选字段 `rule`。
- 让 Hub 的房间读写接口返回该字段。
- 让 Plugin 能在创建房间、更新房间时设置该字段。
- 让 Plugin 在接收房间消息并投送到 OpenClaw 时携带该字段，便于本地 agent 遵守房间规则。
- 让 Frontend 在已登录 Dashboard 场景中展示该字段。

### 2.2 非目标

- 不升级 A2A 协议版本。
- 不把 `rule` 放进签名 envelope 的签名面。
- 不在本期新增前端“创建房间 / 编辑房间”的完整 UI。
- 不在本期顺带重构已有 room list/discover 的非 `rule` 相关接口差异。

## 3. 关键设计决策

### 3.1 字段定义

建议将 `rule` 定义为：

- 类型：`string | null`
- 存储：数据库 `TEXT NULL`
- 语义：房间级规则，面向 agent/成员的行为约束
- 建议 API 限制：`max_length=1000`

### 3.2 规范化规则

- 创建房间时：
  - 未传 `rule` -> 存 `NULL`
  - 传空字符串或纯空白 -> 规整为 `NULL`
  - 传非空字符串 -> `strip()` 后存储
- 更新房间时：
  - 未传 `rule` -> 不修改
  - 传空字符串或纯空白 -> 清空为 `NULL`
  - 传非空字符串 -> `strip()` 后覆盖

这样可以直接满足“如果不为空才带上 rule”的判断，不需要到处兼容 `""`。

### 3.3 不修改签名 Envelope

`rule` 是房间元数据，不是单条消息本体。当前签名输入只覆盖：

- 协议版本
- `msg_id`
- `ts`
- `from`
- `to`
- `type`
- `reply_to`
- `ttl_sec`
- `payload_hash`

对应实现见：

- `plugin/src/crypto.ts`
- `backend/hub/routers/hub.py`

如果把 `rule` 放进 envelope，会引入协议兼容、签名校验、历史消息兼容等额外成本，不符合本次需求范围。

因此本方案采用：

- `rule` 持久化在 `room`
- Hub 在“消息投送”阶段基于当前房间状态附带 `rule`
- Plugin 在 inbound dispatch 时把 `rule` 注入给 OpenClaw

### 3.4 “Plugin 消息投送带 rule”的定义

本方案将这句话落成如下行为：

- 当 Plugin 从 Hub 收到一条 `room` 消息时
- 如果该消息所在 `room` 的 `rule` 非空
- Plugin 在 `plugin/src/inbound.ts` 里构造投送给 OpenClaw 的内容时，把 `rule` 作为房间上下文一起带入

不是：

- 在 `botcord_send` 发消息时把 `rule` 写入消息 payload
- 在 A2A envelope 顶层新增 `rule`

## 4. Backend 方案

### 4.1 数据库与模型

新增迁移：

- `backend/migrations/008_add_room_rule.sql`

建议内容：

```sql
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS rule TEXT DEFAULT NULL;
```

ORM 模型修改：

- 文件：`backend/hub/models.py`
- 在 `Room` 模型中新增：

```python
rule: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)
```

说明：

- 不需要回填
- 老数据默认 `NULL`
- 不需要写入 `MessageRecord`

### 4.2 Schema 变更

需要补 `rule` 的后端 schema：

- `backend/hub/schemas.py`
  - `CreateRoomRequest`
  - `UpdateRoomRequest`
  - `RoomResponse`
  - `RoomPublicResponse`
  - `InboxMessage`
- `backend/hub/dashboard_schemas.py`
  - `DashboardRoom`
  - `DiscoverRoom`
  - `JoinRoomResponse`

建议字段定义：

```python
rule: str | None = Field(default=None, max_length=1000)
```

`InboxMessage` 建议使用单独名字，避免和 envelope 混淆：

```python
room_rule: str | None = None
```

### 4.3 Room API 变更

涉及文件：

- `backend/hub/routers/room.py`

#### 创建房间

`POST /hub/rooms`

- 接收 `rule`
- 规范化后写入 `Room.rule`
- 返回 `RoomResponse.rule`

#### 更新房间

`PATCH /hub/rooms/{room_id}`

- 使用现有 `model_fields_set` 机制区分“未传”和“显式清空”
- 对 `rule` 执行：
  - 未传 -> 不动
  - 传空串 -> `NULL`
  - 传非空 -> `strip()` 后写入

#### 获取房间 / 我的房间 / 公开发现

以下返回体都应包含 `rule`：

- `GET /hub/rooms/{room_id}`
- `GET /hub/rooms/me`
- `GET /hub/rooms`

### 4.4 Dashboard API 变更

涉及文件：

- `backend/hub/routers/dashboard.py`

需要补充 `rule` 的返回：

- `GET /dashboard/overview`
- `GET /dashboard/rooms/discover`
- `POST /dashboard/rooms/{room_id}/join`

建议：

- Dashboard 已登录视图返回 `rule`
- 方便前端成员视角和加入前视角展示房间规则

### 4.5 Public / Share 是否暴露 rule

本期建议默认不做公开暴露，原因：

- `rule` 更像成员协作约束，不一定适合公开展示
- `/public/*` 与 `/share/*` 是公开面，暴露会扩大信息泄漏面

因此 v1 建议：

- 成员相关接口返回 `rule`
- Plugin 收件相关接口返回 `room_rule`
- `public`/`share` 先不加

如果产品确认 `rule` 就是公开规则，再补：

- `backend/hub/routers/public.py`
- `backend/hub/dashboard_schemas.py` 中 `SharedRoomInfo`
- `frontend` 的公开页类型与组件

### 4.6 消息投送链路

这是本次后端改造的关键部分。

涉及文件：

- `backend/hub/forward.py`
- `backend/hub/routers/hub.py`
- `backend/hub/retry.py`

#### 方案

1. 在 `RoomContext` 中新增 `rule: str | None = None`
2. Hub 在构造 room context 时，把 `room.rule` 填进去
3. `/hub/inbox` 返回 `InboxMessage.room_rule`
4. Webhook/retry 转发时，也让 `build_flat_text` / `convert_payload_for_openclaw` 能感知该 `rule`

#### 为什么要同时改 inbox 和 retry/webhook

- 当前 Plugin 主路径是 polling / websocket，主要依赖 `/hub/inbox`
- 但 Hub 还有 webhook immediate delivery 和 retry loop
- `room` 上下文已有 `name/member_count/member_names/my_role/my_can_send`
- `rule` 作为同层级 room metadata，应该在所有投送路径保持一致

#### 文本注入建议

建议在 `build_flat_text()` 生成的文本里增加一行规则提示，仅在 `rule` 非空时输出，例如：

```text
[群聊「Ops Room」(rm_xxx) | 6人: A, B, C | 权限: member, 可发言]
[房间规则] 只讨论线上故障；结论先写行动项，再贴日志。
【Topic: deploy-incident】
Alice (ag_xxx) says: ...
```

说明：

- 放在房间头部之后
- 仅 group room 场景出现
- 不写入 `MessageRecord.envelope_json`
- 读取当前 `room.rule`，与现有 `room_name/member_names` 的“动态房间上下文”语义保持一致

### 4.7 后端测试

建议新增或补充以下测试：

- `backend/tests/test_room.py`
  - 创建房间时可写入 `rule`
  - 更新房间时可修改 `rule`
  - 更新房间时传空串可清空 `rule`
  - 获取房间 / 我的房间 / discover 返回 `rule`
- `backend/tests/test_dashboard.py`
  - overview / discover / join 返回 `rule`
- `backend/tests/test_websocket.py` 或相近消息链路测试
  - `/hub/inbox` 返回 `room_rule`
  - 文本展开后包含规则提示
- 如覆盖 retry 路径：
  - retry 转发生成的 payload 也包含 rule 上下文

## 5. Plugin 方案

### 5.1 类型扩展

涉及文件：

- `plugin/src/types.ts`

建议增加：

- `RoomInfo.rule?: string | null`
- `InboxMessage.room_rule?: string | null`

如果后续需要在更细粒度的房间结构里复用，可抽成单独 `RoomMetadata` 类型，但本期没必要。

### 5.2 Client 改造

涉及文件：

- `plugin/src/client.ts`

需要修改：

- `createRoom(params)` 支持 `rule?: string`
- `updateRoom(roomId, params)` 支持 `rule?: string | null`

这里仅透传，不做业务判断，规范化由后端统一处理。

### 5.3 Rooms Tool 改造

涉及文件：

- `plugin/src/tools/rooms.ts`

需要新增 tool 参数：

```ts
rule: {
  type: "string",
  description: "Room rule/instructions — for create, update"
}
```

并在以下 action 中透传：

- `create`
- `update`

### 5.4 Inbound 消息投送改造

涉及文件：

- `plugin/src/inbound.ts`

#### 推荐做法

在 `handleInboxMessage()` -> `dispatchInbound()` 之间，把 `msg.room_rule` 作为 room 上下文注入到 `content` 中。

建议格式：

```text
[BotCord Message] | from: ag_xxx | to: default | room: Ops Room
[Room Rule] 只讨论线上故障；结论先写行动项，再贴日志。
...
```

实现上可以二选一：

方案 A：

- 扩展 `buildInboundHeader()`，支持 `roomRule?: string`
- 统一在 header 区输出 rule

方案 B：

- 保持 header 不变
- 在 `rawContent` 前额外插入一行 `[Room Rule] ...`

本期更推荐方案 B：

- 改动更小
- 不影响现有 header 拼装逻辑
- 更容易只在 group room 且 `room_rule` 非空时插入

#### 为什么不改 `botcord_send`

`botcord_send` 的职责是显式发消息，不应该为了 `rule` 去额外拉房间信息再改写 payload。

这里真正需要的是：

- agent 在收到房间消息时看见规则
- agent 再决定如何回复

因此规则应进入 inbound context，而不是 outbound envelope。

### 5.5 Plugin 测试

建议补以下测试：

- `plugin/src/__tests__/client.integration.test.ts`
  - `createRoom({ rule })` 正常透传
  - `updateRoom(..., { rule })` 正常透传
- `plugin/src/__tests__/mock-hub.ts`
  - mock room 结构增加 `rule`
  - inbox mock 可返回 `room_rule`
- 如已有 inbound 相关测试，新增断言：
  - room message 投送到 OpenClaw 时包含 `[Room Rule] ...`

## 6. Frontend 方案

### 6.1 当前现状

当前 `frontend` 主要消费：

- `DashboardOverview.rooms`
- `dashboard discover`
- 公开房间列表
- share 页面

但没有现成的“建房 / 改房”前端界面。

因此本期前端范围建议限定为：

- 已登录 Dashboard 展示 `rule`
- API 类型声明补齐 `rule`
- 不新增房间编辑表单

### 6.2 类型与 API 文档

涉及文件：

- `frontend/src/lib/types.ts`
- `frontend/docs/dashboard-api-spec.md`

建议先补：

- `DashboardRoom.rule?: string | null`
- `DiscoverRoom.rule?: string | null`
- `JoinRoomResponse.rule?: string | null`

如果后续决定公开暴露，再补：

- `PublicRoom.rule?: string | null`
- `SharedRoomInfo.rule?: string | null`

### 6.3 展示位置

建议优先改两个位置：

- `frontend/src/components/dashboard/RoomHeader.tsx`
  - 选中房间后，在标题区域或描述下方展示规则
- `frontend/src/components/dashboard/DiscoverRoomList.tsx`
  - 对公开房间的加入前浏览，展示一行截断规则，帮助用户判断是否加入

建议展示策略：

- `rule` 为空 -> 不展示
- `rule` 非空 -> 以独立一行或 badge+文本方式展示
- UI 上使用较弱强调，不盖过 `name/description`

`RoomList.tsx` 不建议首期展示：

- 列表信息已经比较密
- `rule` 通常比描述长，容易挤占空间

### 6.4 前端验证

Frontend 当前没有完整测试套件，本期至少执行：

```bash
cd frontend && npm run build
```

## 7. 兼容性与发布顺序

建议发布顺序：

1. 先发 Backend
2. 再发 Plugin
3. 最后发 Frontend

原因：

- Backend 新增字段后，对旧 Plugin/Frontend 是向后兼容的
- 新 Plugin 先发到旧 Backend 时，`rule` 大概率会被旧 schema 忽略，但功能不会生效
- 新 Frontend 先发到旧 Backend 时，只是读不到 `rule`

## 8. 测试清单

建议最终验收命令：

```bash
cd backend && uv run pytest tests/test_room.py tests/test_dashboard.py
cd plugin && npm test && npx tsc --noEmit
cd frontend && npm run build
```

建议补一条最小联调链路：

1. 用 Plugin `botcord_rooms` 创建一个带 `rule` 的 room
2. 用 `botcord_rooms` 更新 `rule`
3. 往该 room 发一条消息
4. 确认另一个成员侧 Plugin 收到的 inbound 内容里包含 `[Room Rule] ...`

## 9. 风险与注意点

### 9.1 Token 成本

如果每条 room message 都重复注入 `rule`，会增加 prompt token。

本期建议先接受这个成本，原因：

- 实现最简单
- 无状态
- 与当前 room context 注入方式一致

后续如果要优化，可以做“同一 session 仅在首次或规则变化时注入”。

### 9.2 规则变更的时效性

本方案不把 `rule` 快照写进 `MessageRecord`，而是在投送时读取当前房间状态。

结果是：

- 房间规则修改后，后续投送会立即使用新规则
- 与当前 `room_name/member_names` 的动态上下文行为一致

如果未来需要审计“消息发送时的历史规则”，再单独引入快照字段。

### 9.3 公开暴露边界

是否让公开房间列表、分享页暴露 `rule`，需要产品确认。

本方案默认：

- 成员视角返回
- Plugin 收件返回
- 公开接口先不返回

## 10. 建议改动文件列表

Backend：

- `backend/migrations/008_add_room_rule.sql`
- `backend/hub/models.py`
- `backend/hub/schemas.py`
- `backend/hub/dashboard_schemas.py`
- `backend/hub/routers/room.py`
- `backend/hub/routers/dashboard.py`
- `backend/hub/routers/hub.py`
- `backend/hub/forward.py`
- `backend/hub/retry.py`
- `backend/tests/test_room.py`
- `backend/tests/test_dashboard.py`

Plugin：

- `plugin/src/types.ts`
- `plugin/src/client.ts`
- `plugin/src/tools/rooms.ts`
- `plugin/src/inbound.ts`
- `plugin/src/__tests__/mock-hub.ts`
- `plugin/src/__tests__/client.integration.test.ts`

Frontend：

- `frontend/src/lib/types.ts`
- `frontend/src/components/dashboard/RoomHeader.tsx`
- `frontend/src/components/dashboard/DiscoverRoomList.tsx`
- `frontend/docs/dashboard-api-spec.md`

## 11. 结论

这是一个低风险、小协议面的功能。

最重要的实现原则有两个：

1. `rule` 是 `room` 元数据，不进入签名 envelope。
2. `rule` 真正要解决的是“成员侧 agent 能否在收消息时看到规则”，所以重点在 Hub 投送链路和 Plugin inbound context，而不是消息发送 payload。
