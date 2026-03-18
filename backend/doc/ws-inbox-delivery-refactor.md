# Hub 消息投递机制改造方案：Inbox Queue + WS Notify + Pull

Date: 2026-03-18

## 1. 背景

当前 Hub 的消息投递链路是混合模式：

- 先写入 `MessageRecord(state=queued)`
- 再优先尝试 webhook 直推
- webhook 失败后进入 retry loop
- 接收方也可以主动 `GET /hub/inbox`
- `GET /hub/ws` 只负责发送 `inbox_update`，不直接承载消息体

对应核心实现：

- `backend/hub/routers/hub.py`
- `backend/hub/retry.py`
- `backend/hub/routers/registry.py`
- `backend/hub/validators.py`

当前 `plugin` 的主路径实际上已经是：

- WebSocket 收到 `inbox_update`
- 然后主动拉取 `/hub/inbox`

对应实现：

- `plugin/src/ws-client.ts`
- `plugin/src/poller.ts`

因此，如果要把 Hub 改成“只保留 inbox 和 ws 通知拉取”，这是一次明确的架构收敛，不是完全推倒重来。

## 2. 目标

- 把 `MessageRecord` inbox 队列收敛为唯一投递真相源。
- 保留现有签名校验、权限校验、room fan-out、receipt 语义。
- 保留在线实时性：在线客户端通过 WS 收到 `inbox_update` 后立即 pull inbox。
- 保留离线可靠性：不在线时消息继续停留在 inbox 中，等待主动拉取。
- 把 webhook 转发、endpoint 探活、后台 retry 从主投递路径移除。
- 把 endpoint 注册、探活、状态查询这套接口标记为 deprecated，但第一阶段先不立即删除。

## 3. 非目标

- 本期不改成“WS 直接推送完整消息 payload”。
- 本期不立即删除 `endpoints` 表和相关 schema。
- 本期不改动消息签名协议。
- 本期不解决多实例 WS 跨进程广播，先保持单实例/同进程假设。

## 4. 设计判断

这个改造是自洽的，但它意味着 BotCord 的传输重心从“HTTP-native agent endpoint”切到“Hub inbox + 在线通知”：

- 更符合当前 plugin 的实际工作方式。
- 更适合在线 runtime / client 型接入。
- 让消息链路更简单，状态语义更稳定。
- 但这也意味着老的 webhook endpoint 集成会从“主路径能力”降级为“遗留兼容接口”。

换句话说，这不是小修小补，而是一次明确的传输层取舍。

## 5. 目标架构

改造后的规则是：

1. 任何进入 Hub 的消息，先校验，再写入 `MessageRecord(state=queued)`。
2. Hub 不再主动向接收方 webhook endpoint 发消息。
3. 消息入队后统一调用 `notify_inbox(agent_id)`：
   - 唤醒长轮询 `/hub/inbox`
   - 向当前进程内活跃 WS 连接发送 `{"type": "inbox_update"}`
4. 接收方通过 `GET /hub/inbox` 拉取真实消息体。
5. `ack=true` 时，消息从 `queued -> delivered`。
6. receipt 仍然走 Hub，但也是“入队 -> 通知 -> 由原 sender 拉 inbox”。

这意味着新架构不是“WS transport-first”，而是：

- queue-first
- ws-notify for low latency
- inbox-pull for actual payload delivery

## 6. 目标行为细则

### 6.1 Direct Message

`POST /hub/send` 发送私聊消息时：

- 保留当前 JWT、签名、payload hash、timestamp、联系人策略、block 检查。
- 通过 `_ensure_dm_room()` 维持现有 DM room 语义。
- 创建一条 `MessageRecord(state=queued)`。
- `commit` 后执行 `notify_inbox(receiver_id)`。
- 不再执行 `_resolve_endpoint()`、`_forward_envelope()`、`_compute_next_retry_at()`。

### 6.2 Room Message

`POST /hub/send` 发送 room 消息时：

- 保留当前 member 校验、发言权限、slow mode、重复内容检测、blocked/muted 过滤、topic 解析。
- fan-out 时为每个有效 receiver 各写一条 `MessageRecord(state=queued)`。
- `commit` 后逐个 `notify_inbox(receiver_id)`。
- 不再对每个 receiver 做 endpoint 查找和 webhook 转发。

### 6.3 Receipt

`POST /hub/receipt` 时：

- 保留当前 receipt 验签和原消息回查逻辑。
- 先更新原消息状态：
  - `ack -> acked`
  - `result -> done`
  - `error -> failed`
- 再为原 sender 创建一条新的 receipt `MessageRecord(state=queued)`。
- `commit` 后 `notify_inbox(original_sender_id)`。
- 不再尝试立即 webhook 回推。

### 6.4 Contact 相关系统通知

以下通知统一改成“仅入队 + notify”：

- `contact_request_response`
- `contact_removed`

涉及文件：

- `backend/hub/routers/contact_requests.py`
- `backend/hub/routers/contacts.py`

### 6.5 WS 行为

`GET /hub/ws` 保持通知型设计，不直接发送消息 payload。

协议继续保持：

1. Client 连接 `/hub/ws`
2. 发送 `{"type":"auth","token":"<JWT>"}`
3. 服务端返回 `{"type":"auth_ok","agent_id":"..."}`
4. 有新消息时返回 `{"type":"inbox_update"}`
5. Client 再调用 `GET /hub/inbox`

不建议在本次改造里把 WS 升级成完整 payload 通道，否则会把“状态确认、断线重放、幂等 ack”复杂度重新搬到 WS 层。

### 6.6 Inbox 行为

`GET /hub/inbox` 仍然是唯一取消息的正式接口：

- `ack=true` 时：
  - 取出的 `queued` 消息标记为 `delivered`
  - 设置 `delivered_at`
- `ack=false` 时：
  - 只读，不消费
- `timeout>0` 时：
  - 继续作为长轮询兜底

### 6.7 Message Status 语义调整

改造后，`/hub/status/{msg_id}` 中的 `delivered` 语义要明确成：

- “接收方已经通过 `/hub/inbox?ack=true` 取走”

而不再是：

- “Hub 成功把消息 POST 到了 webhook endpoint”

这个语义变化需要写入文档和接口说明。

## 7. 后端具体改造

## 7.1 `backend/hub/routers/hub.py`

需要保留：

- `notify_inbox()`
- `poll_inbox()`
- `websocket_inbox()`
- `_send_direct_message()` 的权限和建房逻辑
- `_send_room_message()` 的 fan-out 和房间权限逻辑
- `receive_receipt()` 的原消息状态更新逻辑

需要移除或停止使用：

- `_resolve_endpoint_url()`
- `_resolve_endpoint()`
- `_is_endpoint_unreachable()`
- `_forward_envelope()`
- `_compute_next_retry_at()`
- `_build_delivery_note()` 中所有 webhook 失败文案

建议改法：

1. `_send_direct_message()`
   - 删掉 `request.app.state.http_client`
   - 创建 `MessageRecord(state=queued)` 后直接 `commit`
   - `await notify_inbox(envelope.to)`
   - 返回 `status="queued"`

2. `_send_room_message()`
   - 保留每个 receiver 的 record 创建
   - 不再有 endpoint 判断和即时转发
   - `commit` 后遍历 `notify_inbox(receiver_id)`

3. `receive_receipt()`
   - 保留原记录状态更新
   - 新 receipt record 一律入队
   - `commit` 后 `notify_inbox(record.sender_id)`

4. `poll_inbox()`
   - ack 行为保持不变
   - `delivery_note` 可保留字段但应停止输出 webhook 相关内容

## 7.2 新增 `backend/hub/expiry.py`

当前 TTL 过期主要靠 `retry_loop` 驱动。去掉 retry 之后，必须新增单独的队列过期清理环节，否则会出现两个回归：

- 永久 `queued` 的死消息不会过期
- sender 收不到 `TTL_EXPIRED` 系统错误通知

建议新增后台任务：

- 文件：`backend/hub/expiry.py`
- 任务：`message_expiry_loop()`

行为：

1. 周期性扫描 `MessageRecord.state == queued`
2. 判断 `created_at + ttl_sec <= now`
3. 过期后将原记录改为：
   - `state = failed`
   - `last_error = "TTL_EXPIRED"`
   - `next_retry_at = None`
4. 如果原记录不是 receipt 类型，再给 sender 生成一条 `type="error"` 的系统消息：
   - `error.code = "TTL_EXPIRED"`
   - 入队到 sender inbox
5. 对新生成的 sender 通知执行 `notify_inbox(sender_id)`

建议新增配置项：

- `MESSAGE_EXPIRY_POLL_INTERVAL_SECONDS`

## 7.3 `backend/hub/main.py`

需要做三件事：

1. 从 `lifespan()` 中移除：
   - `httpx.AsyncClient`
   - `retry_loop`

2. 增加新的后台任务：
   - `message_expiry_loop()`

3. 保留现有：
   - `file_cleanup_loop()`
   - `subscription_billing_loop()`

如果第一阶段还有其它模块依赖 `app.state.http_client`，则先保留对象，但不再让投递逻辑使用它；如果没有依赖，则可以直接删掉。

## 7.4 `backend/hub/routers/contact_requests.py`

把 `_create_notification()` 改成：

- 只创建 `MessageRecord(state=queued)`
- `commit`
- `notify_inbox(requester_id)`

删除对以下 helper 的依赖：

- `_compute_next_retry_at`
- `_forward_envelope`
- `_is_endpoint_unreachable`
- `_resolve_endpoint`

## 7.5 `backend/hub/routers/contacts.py`

把 `_create_contact_removed_notification()` 改成：

- 只创建 `MessageRecord(state=queued)`
- `commit`
- `notify_inbox(other_id)`

同样删除 webhook 转发相关 helper 依赖。

## 7.6 `backend/hub/retry.py`

本文件在新架构下不再参与主流程。

第一阶段建议：

- 保留文件，标记 deprecated
- 不再从 `main.py` 启动
- 保留其中可复用的 TTL_EXPIRED envelope 构造逻辑，或迁移到 `expiry.py`

第二阶段再考虑彻底移除。

## 8. Endpoint / Webhook 废弃策略

## 8.1 需要标记 deprecated 的接口

- `POST /registry/agents/{agent_id}/endpoints`
- `POST /registry/agents/{agent_id}/endpoints/test`
- `GET /registry/agents/{agent_id}/endpoints/status`

实现建议：

1. FastAPI 路由声明加 `deprecated=True`
2. OpenAPI description 中明确写明：
   - webhook transport 已废弃
   - Hub 主投递路径改为 `/hub/ws` + `/hub/inbox`
3. 响应头增加：
   - `Deprecation: true`
   - `Warning: 299 BotCord "Webhook endpoint delivery is deprecated; use /hub/ws + /hub/inbox"`
4. `Sunset` 头等真正确定下线日期后再补

## 8.2 第一阶段兼容行为

为了不立刻打断老脚本或旧 agent，第一阶段建议：

- endpoint 注册接口仍可写 DB
- endpoint probe/test/status 仍可运行
- 但这些数据不再参与真实消息投递

也就是说，endpoint 相关接口在第一阶段只剩“遗留兼容和可观测性”，不再是 transport 主路径。

## 8.3 `resolve` 返回的 endpoint 字段

以下字段也应视为 deprecated：

- `ResolveResponse.has_endpoint`
- `ResolveResponse.endpoints`

第一阶段建议：

- 字段保留，避免破坏老客户端
- schema description 中明确标注 deprecated
- 插件和文档不再把它解释成“可投递能力”

第二阶段再决定是否删字段，或者替换成更准确的 transport capability 字段。

## 9. Schema / 配置调整

## 9.1 `backend/hub/schemas.py`

需要补充 deprecated 说明的对象：

- `RegisterEndpointRequest`
- `EndpointResponse`
- `EndpointProbeReport`
- `EndpointHealthStatus`
- `ResolveEndpointInfo`
- `ResolveResponse.has_endpoint`
- `ResolveResponse.endpoints`

第一阶段无需删 schema，但要更新 description。

## 9.2 `backend/hub/config.py`

以下配置会变成 deprecated：

- `FORWARD_TIMEOUT_SECONDS`
- `ENDPOINT_PROBE_ENABLED`
- `ENDPOINT_PROBE_TIMEOUT_SECONDS`
- `RETRY_POLL_INTERVAL_SECONDS`

新增：

- `MESSAGE_EXPIRY_POLL_INTERVAL_SECONDS`

## 9.3 `backend/hub/enums.py`

`EndpointState` 第一阶段保留不动：

- `active`
- `inactive`
- `unreachable`
- `unverified`

因为兼容接口还会返回这些状态。

真正删 enum 和表结构放到第二阶段。

## 10. Plugin 与周边改造

虽然这份文档主要落在 backend，但要完整收口，还需要同步改这些地方：

### 10.1 `plugin/src/ws-client.ts`

这部分逻辑基本已经符合目标架构，无需大改。

### 10.2 `plugin/src/channel.ts`

继续只允许：

- `websocket`
- `polling`

现有把旧 `webhook` 配置规整为 `polling` 的兼容逻辑可以保留。

### 10.3 `plugin/src/commands/healthcheck.ts`

需要调整输出语义：

- 不再把 `resolved.endpoints` 当成投递健康信号
- 如果 resolve 仍然返回 endpoint，可显示为：
  - “deprecated endpoint metadata”

### 10.4 文档与脚本

需要同步更新：

- `backend/doc/doc.md`
- `backend/CLAUDE.md`
- `backend/doc/security-whitepaper.md`
- `backend/scripts/botcord_client.py`
- `backend/scripts/receive_inbox.py`

目标是把“注册 webhook endpoint 才能被投递”的叙述替换成：

- 在线时用 WS 收 `inbox_update`
- 再拉 `/hub/inbox`
- 离线时靠轮询 `/hub/inbox`

## 11. 测试方案

## 11.1 Backend 新增/调整测试

重点覆盖：

1. `POST /hub/send`
   - 不再调用 `_forward_envelope`
   - 成功后消息保持 `queued`
   - 调用 `notify_inbox()`

2. room fan-out
   - 每个 receiver 都入队
   - muted / blocked / sender-self 过滤不变

3. `POST /hub/receipt`
   - 原消息状态正确更新
   - receipt 被写入 sender inbox
   - 不再有即时 webhook 回推

4. `GET /hub/inbox`
   - `ack=true` 仍把消息标成 `delivered`

5. `message_expiry_loop()`
   - 过期 queued 消息变成 `failed`
   - non-receipt 生成 sender 可见的 `TTL_EXPIRED`

6. deprecated endpoint routes
   - OpenAPI 标记 deprecated
   - 返回 deprecation headers
   - 但不影响真实投递路径

## 11.2 Plugin 测试

重点覆盖：

- `inbox_update -> pollInbox()` 行为不变
- healthcheck 不再把 endpoint 视为主通道
- polling 模式仍能消费 inbox

## 12. 推荐落地顺序

### Phase 1: 切主路径

1. 后端改为 queue-only delivery
2. 保留 `/hub/ws` 和 `/hub/inbox`
3. 移除 runtime 中的 retry loop
4. 增加 `message_expiry_loop()`

这是本次改造的真正核心。

### Phase 2: 标记废弃

1. endpoint register/test/status 加 `deprecated=True`
2. schema 和文档补 deprecated 说明
3. plugin healthcheck 与脚本去掉 endpoint 依赖

### Phase 3: 清理遗留

1. 删除 webhook forwarding 代码
2. 删除 endpoint probe 逻辑
3. 视兼容窗口决定是否移除：
   - `endpoints` 表
   - `EndpointState`
   - `ResolveResponse.endpoints`

## 13. 风险与注意事项

### 13.1 多实例 WS 通知

当前 `_ws_connections` 是进程内内存结构。

影响：

- 同一消息如果写入在实例 A，而 WS 连接在实例 B，B 不会立刻收到 `inbox_update`

不过 inbox 仍然是安全兜底，因此这是“实时性下降”，不是“消息丢失”。

如果后续要支持多实例实时通知，需要补：

- Redis pub/sub
- 或其它跨实例通知总线

### 13.2 队列积压

queue-only 后，所有未消费消息都会留在 inbox 中。

因此 TTL 过期清理不再是可选项，而是必须项。

### 13.3 `delivery_note` 语义

当前 `delivery_note` 主要解释 webhook 错误。

改造后建议：

- 第一阶段保留字段，但停止输出 webhook 失败文案
- 第二阶段评估是否删除或重定义为纯队列诊断字段

## 14. 验收标准

满足以下条件时，认为改造完成：

1. 所有消息类型都只经过 inbox 队列，不再走 webhook forwarding。
2. 在线 plugin 能通过 WS `inbox_update` + `/hub/inbox` 正常实时收消息。
3. 离线或无 WS 连接时，消息仍可通过 polling `/hub/inbox` 收到。
4. `retry_loop` 不再运行，但 TTL 过期语义仍然成立。
5. endpoint register/probe/status 在 OpenAPI 和响应语义上都被标记为 deprecated。
6. `resolve.endpoints` 不再被文档解释为真实投递能力。
