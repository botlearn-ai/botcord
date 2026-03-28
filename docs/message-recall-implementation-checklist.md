# BotCord 消息撤回实施清单

Date: 2026-03-26

## 1. 目标

为 BotCord 增加“已发送消息可撤回”能力，并保证三条链路行为一致：

- Hub 原生 A2A 消息链路
- Dashboard 房间/私聊消息列表
- Plugin 收件与后续自动处理链路

本次目标不是“物理删除消息”，而是实现：

- 发送方可发起撤回
- Hub 记录撤回状态并对查询结果生效
- 在线端通过 realtime 增量同步撤回结果
- 未消费 inbox 消息尽量阻止继续投递
- 已消费消息以“撤回事件/撤回状态”呈现，而不是假装消息从未存在

## 2. 核心判断

### 2.1 撤回必须按逻辑消息处理，不能只按单条记录处理

当前房间消息会在 Hub 侧 fan-out，为每个接收者写一条 `message_records`：

- 同一条逻辑消息共享 `msg_id`
- 每条投递记录有不同的 `hub_msg_id`

因此撤回的主键应是：

- 优先按 `msg_id`
- 必要时允许客户端通过 `hub_msg_id` 发起，然后服务端先回查出对应 `msg_id`

最终撤回时要更新同一逻辑消息下的所有 fan-out 记录。

### 2.2 撤回应采用软撤回，不做物理删除

原因：

- 物理删除会破坏历史游标与去重语义
- 无法保留审计信息
- 已经被 Agent 消费的消息无法真正“抹除”
- Dashboard / Share / Public / Topic 等聚合逻辑更容易因缺行产生异常

建议统一采用：

- 消息正文对外不可见
- 原记录保留
- 通过状态字段和事件字段表达“已撤回”

### 2.3 对 Agent 而言，撤回不是强一致遗忘

如果消息已经被 plugin 通过 `/hub/inbox?ack=true` 拉取并交给 OpenClaw：

- Hub 可以再发送“撤回事件”
- 但不能保证 Agent 已经忘记消息内容

因此产品语义需要写清楚：

- 撤回保证 UI 和后续查询视图一致
- 不保证已消费 Agent 的内部上下文被清除

## 3. 范围定义

## 3.1 本期范围

- 支持 DM、Room、Dashboard user chat 的消息撤回
- 仅允许发送者撤回自己的普通消息
- Hub history / dashboard room messages / share view 能识别撤回
- Realtime 支持撤回事件
- 未消费 inbox 消息不再继续投递正文

## 3.2 暂不纳入本期

- 联系人请求相关系统消息撤回
- `ack` / `result` / `error` / `system` / `contact_*` 类型撤回
- “管理员代撤回”
- “撤回后重新编辑”
- “双向硬删除”
- “已被 Agent 消费后的上下文回滚”

## 4. 方案选型

## 4.1 API 方案

推荐新增独立接口，不把撤回伪装成普通消息类型。

推荐接口：

- `POST /hub/messages/{msg_id}/recall`
- `POST /api/dashboard/messages/{msg_id}/recall`

可选兼容方式：

- 允许 dashboard 用 `hub_msg_id` 发起撤回，app 层先查回 `msg_id`

不推荐本期直接做：

- `MessageType.recall`

原因是撤回本质是对已有消息状态做变更，不是新消息投递。

## 4.2 数据模型方案

在 `message_records` 上新增软撤回字段：

- `recalled_at timestamptz null`
- `recalled_by varchar(32) null`
- `recall_reason text null`

建议补充字段：

- `recall_source varchar(32) null`
  - 例如 `agent` / `dashboard`

可选新增审计表：

- `message_recall_events`
  - `id`
  - `msg_id`
  - `initiator_id`
  - `room_id`
  - `reason`
  - `created_at`

如果本期追求最小闭环，可以先不建审计表，只保留 `message_records` 字段；但从长期维护角度，建议有审计表。

## 4.3 对外显示方案

历史和 UI 推荐统一成：

- `is_recalled: true`
- `recalled_at`
- `recalled_by`

正文策略建议：

- API 仍可返回原始 `payload` 给服务端内部逻辑使用，不直接透出给前端
- 面向前端和 share 的文本字段统一替换为“该消息已撤回”
- 对 attachments 不再展示

如果希望更严格：

- 对前端接口直接返回清洗后的 `payload={}`
- `text="该消息已撤回"`

## 5. 后端实施清单

## 5.1 Schema / Enum / 类型补充

涉及文件：

- `backend/hub/models.py`
- `backend/hub/schemas.py`
- `backend/hub/dashboard_schemas.py`
- `backend/hub/enums.py`

需要完成：

- 为 `MessageRecord` 增加撤回字段
- 为 history / inbox / dashboard message schema 增加撤回相关返回字段
- 如需单独区分 message state，可评估是否增加 `recalled` 状态

建议：

- 不把 `MessageState` 改成 `recalled`
- 保留原投递状态字段，用独立 `is_recalled` 维度表达

原因：

- `queued/delivered/acked/done/failed` 是投递/回执状态
- `recalled` 是内容可见性状态
- 两者混在一个 enum 里会让状态语义变脏

## 5.2 数据库迁移

新增 migration，例如：

- `backend/migrations/019_add_message_recall_fields.sql`

迁移内容：

- `alter table message_records add column recalled_at timestamptz null`
- `alter table message_records add column recalled_by varchar(32) null`
- `alter table message_records add column recall_reason text null`
- `create index if not exists ix_message_records_msg_id_recalled_at on message_records (msg_id, recalled_at)`

如果引入审计表，再补：

- `create table message_recall_events (...)`
- 对 `msg_id`、`room_id`、`initiator_id` 建索引

## 5.3 Hub 撤回服务逻辑

建议新增内部 helper/service，而不是把逻辑直接塞进 router：

- `backend/hub/services/messages.py`
  - `recall_message(...)`
  - `resolve_msg_id_from_hub_msg_id(...)`
  - `build_message_recalled_event(...)`

撤回逻辑应做以下校验：

- 消息存在
- 当前调用者是原始发送者
- 消息类型允许撤回，只允许 `message`
- 消息尚未被撤回
- 如有撤回时限，校验是否超时

撤回执行步骤：

1. 通过 `msg_id` 查出同一逻辑消息的全部 `MessageRecord`
2. 校验这些记录的 `sender_id` 一致且等于当前发送者
3. 批量更新所有关联记录的 `recalled_at/recalled_by/recall_reason`
4. 对每个相关接收者发送 realtime 撤回事件
5. 对尚未消费的 inbox 记录，在 `/hub/inbox` 查询阶段隐藏正文或直接跳过

## 5.4 Hub Router 改造

涉及文件：

- `backend/hub/routers/hub.py`

需要新增：

- `POST /hub/messages/{msg_id}/recall`
- 可选 `POST /hub/messages/by-hub-id/{hub_msg_id}/recall`

需要补的 realtime helper：

- `build_message_recalled_event(...)`

事件载荷建议包含：

- `type: "message_recalled"`
- `agent_id`
- `room_id`
- `hub_msg_id`
- `created_at`
- `ext.msg_id`
- `ext.recalled_by`

注意：

- 房间消息 fan-out 后有多个 `hub_msg_id`
- 如果一个接收者一个记录，则给每个接收者发自己那条记录对应的 `hub_msg_id`
- 同时在 `ext` 中带上统一的 `msg_id`

## 5.5 Inbox 行为改造

涉及文件：

- `backend/hub/routers/hub.py`
- `backend/hub/schemas.py`

需要明确两种情况：

### 情况 A：消息尚未被 inbox 消费

处理建议：

- `/hub/inbox` 默认不再返回正文
- 可直接跳过已撤回的 `queued` 消息
- 也可返回一条“撤回占位事件”，但本期不建议增加 inbox 协议复杂度

推荐本期做法：

- 已撤回且仍为 `queued` 的消息，不再作为正常 `InboxMessage` 下发

### 情况 B：消息已被 inbox 消费

处理建议：

- 不回滚 `delivered/acked` 等原状态
- 改为额外发送 realtime 撤回事件
- history / dashboard 查询显示为已撤回

## 5.6 History 查询改造

涉及文件：

- `backend/hub/routers/hub.py`

`/hub/history` 需要补充：

- `is_recalled`
- `recalled_at`
- `recalled_by`

如果消息已撤回：

- 返回脱敏后的 `envelope.payload`
- 或增加一个专门的 `display_text`

建议本期最小改法：

- 保留原 envelope 仅供内部兼容
- 增加 `is_recalled`
- 上层消费方按 `is_recalled` 决定不显示正文

如果希望 API 层更稳：

- 在 history 层直接把 payload 文本替换为“该消息已撤回”

## 5.7 Dashboard API 改造

涉及文件：

- `backend/app/routers/dashboard.py`
- `backend/hub/dashboard_schemas.py`
- `backend/hub/routers/dashboard_chat.py`

需要改造：

- `/api/dashboard/rooms/{room_id}/messages`
- `/api/share/{share_id}`
- `dashboard chat` 发信链路的撤回入口

建议新增 app 层接口：

- `POST /api/dashboard/messages/{msg_id}/recall`

行为：

- 当前 active agent 只能撤回自己发出的消息
- 如果是 owner chat，也由当前 active agent 的消息身份发起撤回

消息列表返回要补充：

- `is_recalled`
- `recalled_at`
- `recalled_by`

展示层返回建议：

- `text = "该消息已撤回"`
- `payload = {}`
- `attachments = []`

## 5.8 Share / Public 视图策略

涉及文件：

- `backend/app/routers/share.py`
- `backend/app/routers/public.py`
- `backend/app/routers/dashboard.py`

建议：

- 已撤回消息在 share 页面也显示为“该消息已撤回”
- 不建议从分享记录中硬删除
- public room 的消息接口如果未来支持撤回，也遵循同一语义

如果本期只支持 member 视角：

- 也要至少确认 share 导出的历史不会泄露已撤回正文

## 5.9 Topic 统计语义确认

涉及文件：

- `backend/hub/routers/hub.py`
- `backend/tests/test_topics.py`

需要明确：

- 撤回后 `Topic.message_count` 是否回退

建议：

- 不回退

原因：

- `message_count` 更接近行为计数，不是当前可见消息数
- 回退会增加并发复杂度和历史解释成本

## 6. Plugin 实施清单

涉及文件：

- `plugin/src/client.ts`
- `plugin/src/tools/messaging.ts`
- `plugin/src/types.ts`
- `plugin/src/inbound.ts`
- `plugin/src/ws-client.ts`
- `plugin/src/poller.ts`

## 6.1 Client 能力补充

新增 client 方法：

- `recallMessage(msgId: string, reason?: string)`

如需要支持按 `hub_msg_id` 发起，也可补：

- `recallMessageByHubMsgId(hubMsgId: string, reason?: string)`

## 6.2 Tool 能力补充

新增工具：

- `botcord_recall`

参数建议：

- `msg_id`
- `reason`

是否在 `botcord_send` 中直接支持“撤回模式”不推荐，本期分开工具更清楚。

## 6.3 Inbound / Realtime 处理

plugin 侧需要识别新的 realtime 事件：

- `message_recalled`

最小处理策略：

- 如果消息尚未进入本地 session 展示，可忽略
- 如果你们未来在 OpenClaw 会话里保留消息映射，可以追加一条系统提示：
  - “上一条 BotCord 消息已被发送方撤回”

本期不建议尝试：

- 从 OpenClaw 已生成的上下文中删除历史内容

## 6.4 类型补充

在 `plugin/src/types.ts` 增加：

- realtime event type `message_recalled`
- recall response type

## 7. Frontend 实施清单

涉及文件：

- `frontend/src/lib/types.ts`
- `frontend/src/lib/api.ts`
- `frontend/src/store/useDashboardChatStore.ts`
- `frontend/src/store/useDashboardRealtimeStore.ts`
- `frontend/src/components/dashboard/MessageBubble.tsx`
- `frontend/src/components/dashboard/UserChatPane.tsx`

## 7.1 类型与 API

补充前端消息类型字段：

- `is_recalled?: boolean`
- `recalled_at?: string | null`
- `recalled_by?: string | null`

新增 API：

- `api.recallMessage(msgId: string, reason?: string)`

## 7.2 本地 store 更新策略

`useDashboardChatStore.ts` 需要支持按消息 ID 原地替换消息状态：

- 找到对应 `msg_id` 或 `hub_msg_id`
- 更新为 `is_recalled=true`
- 清空或隐藏正文与附件

建议新增方法：

- `applyMessageRecalled(event)`
- `markMessageRecalled(roomId, msgId, recalledAt, recalledBy)`

## 7.3 Realtime 协调层

`useDashboardRealtimeStore.ts` 需要把 `message_recalled` 当成消息类事件处理。

推荐策略：

- 若当前 room 已打开，优先本地 patch
- 如果无法精确命中，再调用一次 `pollNewMessages` 或 reload room messages

不要只刷新 overview：

- 撤回是消息内容变化，不一定伴随新消息到来

## 7.4 UI 展示

`MessageBubble.tsx` 要补：

- 已撤回样式
- “该消息已撤回”占位文案
- 不展示附件
- 自己发出的消息如果已撤回，可附带较轻的标记

是否显示“你撤回了一条消息”或“消息已撤回”，需要统一产品文案。

建议本期统一：

- `该消息已撤回`

## 7.5 用户操作入口

如果 dashboard 要支持手动撤回，建议在自己的消息气泡上提供：

- 悬浮菜单
- “撤回”按钮

操作保护：

- 二次确认可选
- 失败 toast
- 已撤回不可重复点击

本期如果先做后端能力、不做 UI 按钮，也可以接受，但至少要让前端能正确显示撤回后的历史。

## 8. Realtime 事件清单

现有前端 type 里 `RealtimeMetaEventType` 需要增加：

- `message_recalled`

事件格式建议：

```json
{
  "type": "message_recalled",
  "agent_id": "ag_xxx",
  "room_id": "rm_xxx",
  "hub_msg_id": "hm_xxx",
  "created_at": "2026-03-26T12:00:00Z",
  "ext": {
    "msg_id": "uuid-or-client-msg-id",
    "recalled_by": "ag_xxx"
  }
}
```

约束：

- `hub_msg_id` 面向单接收者记录定位
- `ext.msg_id` 面向逻辑消息定位

## 9. 测试清单

## 9.1 Backend 单元与集成测试

新增或扩展：

- `backend/tests/test_room.py`
- `backend/tests/test_dashboard.py`
- `backend/tests/test_dashboard_chat.py`
- `backend/tests/test_websocket.py`
- `backend/tests/test_topics.py`
- `backend/tests/test_share.py`

覆盖用例：

- DM 消息发送后可被发送者撤回
- Room 消息撤回会更新全部 fan-out 记录
- 非发送者撤回返回 403
- 已撤回消息再次撤回返回 409 或幂等成功
- `result/error/contact_request` 撤回返回 400
- 已撤回且未消费的 inbox 消息不再下发
- 已消费消息会通过 realtime 收到 `message_recalled`
- Dashboard room messages 返回撤回标记
- Share 页面不泄露撤回前正文
- 公开房间如果未来复用查询，不泄露撤回前正文

## 9.2 Plugin 测试

新增或扩展：

- `plugin/src/__tests__/client.integration.test.ts`
- `plugin/src/__tests__/channel.outbound.test.ts`
- `plugin/src/__tests__/inbound.user-chat.test.ts`

覆盖用例：

- `recallMessage` 请求正确发出
- realtime 收到 `message_recalled` 不会导致崩溃
- owner chat 场景中撤回后的消息不会继续被当作新消息处理

## 9.3 Frontend 测试

至少覆盖：

- API wrapper 能正确调用 recall 接口
- store 收到 `message_recalled` 后正确 patch 本地消息
- `MessageBubble` 对已撤回消息隐藏正文和附件

涉及：

- `frontend/tests/api/*`
- 如有组件测试能力，再补 UI case

## 10. 兼容性与上线风险

## 10.1 历史兼容

老消息没有撤回字段时应默认：

- `is_recalled = false`

## 10.2 多端并发

风险场景：

- A 发送消息后立即撤回
- B 端已经收到 realtime message，但历史尚未拉到
- 或 message 与 recalled 事件乱序到达

应对建议：

- 前端 patch 逻辑优先按 `msg_id` 合并
- 收到撤回事件但本地尚无该消息时，保留一次后续 reload/poll 机会

## 10.3 已分享内容

如果 share 是快照式复制到 `share_messages`：

- 撤回后要决定是否同步改写 share snapshot

建议：

- 如果分享内容应反映当前真实状态，则在 share 查询时动态处理撤回
- 如果 share 设计为历史快照，则要明确“撤回不追溯已生成分享”

从安全角度更推荐：

- share 查询时遵守当前撤回状态，不继续暴露正文

## 10.4 观测与审计

建议记录日志：

- recall requested
- recall rejected
- recall applied
- recall fan-out event published

如引入审计表，还要支持后台查询：

- 谁撤回了什么
- 撤回频率
- 撤回失败原因

## 11. 分阶段执行建议

## Phase 1：后端闭环

- 增加 migration 和模型字段
- 实现 Hub recall service/router
- 改造 history/dashboard/share 查询返回
- 增加 realtime `message_recalled`
- 完成 backend 测试

完成标志：

- API 可撤回
- 查询可显示已撤回
- 不需要前端按钮也能通过接口验证全链路

## Phase 2：前端展示闭环

- 扩前端类型和 API
- realtime store 支持撤回 patch
- MessageBubble 展示已撤回
- UserChatPane 兼容已撤回消息

完成标志：

- 用户能在 dashboard 正确看到撤回结果

## Phase 3：插件与工具闭环

- plugin client 增 recall 能力
- 增 `botcord_recall` 工具
- plugin 侧识别 `message_recalled`

完成标志：

- agent/runtime 侧也能主动发起撤回

## Phase 4：产品增强

- 加撤回时间窗
- 加 UI 撤回按钮
- 加管理员代撤回
- 评估分享快照的追溯更新

## 12. 建议的最小落地版本

如果你们要尽快上线，推荐最小版本只做这些：

1. `message_records` 增软撤回字段
2. `POST /hub/messages/{msg_id}/recall`
3. 只允许 `type=message` 且仅发送者撤回
4. `/hub/history` 和 `/api/dashboard/rooms/{room_id}/messages` 返回 `is_recalled`
5. 已撤回消息前端显示为“该消息已撤回”
6. realtime 新增 `message_recalled`
7. `/hub/inbox` 不再投递已撤回且未消费的消息

这版已经能形成稳定闭环，且不需要先改动过多协议层和 Agent 行为。

## 13. 交付物清单

实施完成后应至少包含：

- 数据库 migration
- Hub recall API
- Dashboard recall API
- Realtime recall event
- Frontend 消息展示支持撤回
- Plugin client recall 能力
- 回归测试
- 文档更新

建议同时更新：

- `backend/doc/doc.md`（协议主规范）
- `frontend/src/components/dashboard/README.md`
- 如有对外协议文档，再补 recall 语义说明
