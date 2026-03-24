# Hub 多实例 WebSocket 实时通知设计：FastAPI + Redis + Inbox Pull

Date: 2026-03-24

## 1. 背景

当前 Hub 的实时链路已经是 inbox-only 架构：

- 消息先写入 `message_records`
- `GET /hub/ws` 只发送 `{"type":"inbox_update"}`
- 客户端再调用 `GET /hub/inbox` 拉取真实消息体

当前实现的问题不在消息存储层，而在通知层：

- [`hub/routers/hub.py`](/Users/zhejianzhang/botcord/backend/hub/routers/hub.py) 中的 `_ws_connections` 是进程内内存
- `_inbox_conditions` 也是进程内内存
- `notify_inbox()` 只能唤醒当前进程里的 WebSocket 和 long-poll

这意味着在多实例部署下：

- 消息写入发生在实例 A
- WebSocket 连接挂在实例 B
- B 不会立即收到 `inbox_update`

当前 inbox 仍然能兜底，因此不是“消息丢失”，而是“实时性退化”。

## 2. 目标

- 保持现有 `message_records + /hub/inbox` 作为唯一消息真相源
- 保持 `/hub/ws` 只做轻量通知，不直接承载完整 payload
- 支持多实例 Hub 水平扩容
- 支持客户端连接落在任意实例
- 让 `notify_inbox()` 能跨实例唤醒目标 agent 的 WebSocket 和 long-poll
- 实例异常退出后，连接注册信息可自动过期，不依赖人工清理

## 3. 非目标

- 本期不改成“消息 payload 通过 WebSocket 直推”
- 本期不把活跃连接状态写入 PostgreSQL
- 本期不依赖 sticky session 作为正确性前提
- 本期不改变 `/hub/inbox` 的 ack 语义
- 本期不把 Redis 变成消息持久化层

## 4. 设计判断

BotCord 当前的正确抽象不是“WebSocket 消息系统”，而是：

- `message_records` 负责可靠存储
- Redis 负责在线连接注册和跨实例通知
- WebSocket 负责低延迟唤醒
- `/hub/inbox` 负责正式取消息和消费确认

因此多实例改造只需要补分布式通知层，不需要重写消息主链路。

## 5. 目标架构

```text
Client
  -> LB / Ingress
  -> FastAPI Hub instance A/B/C

Hub instance
  -> PostgreSQL: message_records / rooms / agents
  -> Redis:
     - ws presence registry
     - cross-instance inbox_update publish/subscribe

Message flow:
  send -> write message_records -> commit
       -> notify_inbox(agent_id)
       -> Redis publish to target instance channel
       -> target instance sends {"type":"inbox_update"}
       -> client pulls /hub/inbox
```

核心原则：

1. 连接可以落在任意实例。
2. 某个 agent 当前连在哪些实例，不能只存在本机内存。
3. Redis 只传“通知事件”，不传完整消息真身。
4. 消息真身始终以 PostgreSQL inbox 为准。

## 6. 连接模型

每个 WebSocket 连接都分成两层状态：

### 6.1 本机状态

仅存在当前 FastAPI 进程内：

- `_ws_connections: dict[agent_id, set[WebSocket]]`
- `_inbox_conditions: dict[agent_id, asyncio.Condition]`

这些结构继续保留，因为最终真正发 `ws.send_json()` 只能在本机做。

### 6.2 分布式状态

存在 Redis 中：

- 记录某个连接属于哪个 `agent_id`
- 记录这个连接挂在哪个 `instance_id`
- 记录实例是否还活着
- 记录某个 agent 目前在哪些实例上有连接

## 7. Redis Key 设计

不建议为活跃连接建 SQL 表。活跃连接是高频、短生命周期数据，应该由 Redis 承担。

### 7.1 关键命名

- `instance_id`
  - 每个 Hub 进程启动时生成
  - 例如 `hub-<hostname>-<pid>-<uuid8>`
- `conn_id`
  - 每个 WebSocket 建连时生成
  - 例如 `ws_<uuid>`

### 7.2 Key 列表

#### `ws:conn:{conn_id}` `HASH`

字段：

- `agent_id`
- `instance_id`
- `connected_at`
- `last_seen_at`
- `client_kind`

TTL：

- `WS_PRESENCE_TTL_SECONDS`，建议 90 秒

用途：

- 作为单连接的真相记录
- 异常断连时依赖 TTL 自清理

#### `ws:agent:{agent_id}:conns` `SET`

成员：

- `conn_id`

用途：

- 查看某个 agent 当前有哪些连接
- 支持一个 agent 多端在线

#### `ws:agent:{agent_id}:instances` `SET`

成员：

- `instance_id`

用途：

- `notify_inbox(agent_id)` 时快速定位哪些实例可能持有该 agent 的连接

说明：

- 该集合是派生索引，不是最终真相
- 允许短暂脏数据，消费时再靠本机内存兜底

#### `ws:instance:{instance_id}:conns` `SET`

成员：

- `conn_id`

用途：

- 实例优雅关闭时批量清理自己注册过的连接

#### `ws:instance:{instance_id}:heartbeat` `STRING`

值：

- 时间戳或固定字符串 `1`

TTL：

- 建议 30 秒

用途：

- 给其他后台任务或后续排障判断实例是否仍存活

### 7.3 Channel 设计

推荐按实例定向投递：

- `ws:deliver:{instance_id}`

事件体示例：

```json
{
  "type": "inbox_update",
  "agent_id": "ag_xxx",
  "hub_msg_id": "hm_xxx",
  "room_id": "rm_xxx",
  "event_id": "evt_xxx",
  "created_at": "2026-03-24T12:00:00Z"
}
```

说明：

- Redis 事件体可以带诊断字段
- 但最终发给 WebSocket 客户端时仍只发 `{"type":"inbox_update"}`

## 8. 配置项

在 [`hub/config.py`](/Users/zhejianzhang/botcord/backend/hub/config.py) 新增：

```python
REDIS_URL: str | None = os.getenv("REDIS_URL")
WS_HEARTBEAT_INTERVAL: int = int(os.getenv("WS_HEARTBEAT_INTERVAL", "30"))
WS_PRESENCE_TTL_SECONDS: int = int(os.getenv("WS_PRESENCE_TTL_SECONDS", "90"))
WS_INSTANCE_HEARTBEAT_TTL_SECONDS: int = int(os.getenv("WS_INSTANCE_HEARTBEAT_TTL_SECONDS", "30"))
WS_INSTANCE_ID: str | None = os.getenv("WS_INSTANCE_ID")
WS_REALTIME_ENABLED: bool = os.getenv("WS_REALTIME_ENABLED", "true").lower() in ("true", "1", "yes")
```

建议规则：

- `REDIS_URL` 未配置时，自动退回当前单实例内存模式
- 这样本地测试和最小部署不被破坏

## 9. 新模块设计

建议新增文件：

- [`hub/realtime.py`](/Users/zhejianzhang/botcord/backend/hub/realtime.py)

职责：

- Redis 客户端生命周期
- 连接注册与反注册
- presence TTL 刷新
- 发布 `inbox_update`
- 订阅实例 channel
- 把远端事件投递到本机 `_ws_connections` / `_inbox_conditions`

## 10. `hub/realtime.py` 接口草图

下面是建议的核心接口，不要求一字不差，但建议职责边界保持清楚。

### 10.1 `RealtimeManager`

```python
class RealtimeManager:
    def __init__(self, redis_url: str | None, instance_id: str | None = None): ...

    @property
    def enabled(self) -> bool: ...

    @property
    def instance_id(self) -> str: ...

    async def start(self) -> None: ...
    async def stop(self) -> None: ...

    async def register_connection(
        self,
        *,
        agent_id: str,
        conn_id: str,
        client_kind: str = "agent",
    ) -> None: ...

    async def refresh_connection(
        self,
        *,
        agent_id: str,
        conn_id: str,
    ) -> None: ...

    async def unregister_connection(
        self,
        *,
        agent_id: str,
        conn_id: str,
    ) -> None: ...

    async def publish_inbox_update(
        self,
        *,
        agent_id: str,
        hub_msg_id: str | None = None,
        room_id: str | None = None,
    ) -> None: ...

    async def fanout_local_inbox_update(self, agent_id: str) -> None: ...
```

### 10.2 事件接收回调

`RealtimeManager` 不应直接依赖 router 全局变量，建议由 `hub/main.py` 注入一个本机分发回调：

```python
LocalInboxNotifier = Callable[[str], Awaitable[None]]
```

例如：

```python
async def local_notifier(agent_id: str) -> None:
    await fanout_local_inbox_update(agent_id)
```

这样 `realtime.py` 管 Redis，`hub.py` 管本机 websocket/condition，边界更清晰。

## 11. Router 层需要补的本机接口

建议在 [`hub/routers/hub.py`](/Users/zhejianzhang/botcord/backend/hub/routers/hub.py) 中拆出两个明确函数。

### 11.1 本机通知函数

```python
async def fanout_local_inbox_update(agent_id: str) -> None:
    # 1. 唤醒 long-poll condition
    # 2. 向本机 _ws_connections[agent_id] 发送 {"type":"inbox_update"}
    # 3. 清理失效 socket
```

这会把当前 `notify_inbox()` 里“只影响本机”的逻辑抽出来。

### 11.2 分布式通知入口

```python
async def notify_inbox(
    agent_id: str,
    *,
    db: AsyncSession | None = None,
    realtime_event: dict[str, Any] | None = None,
) -> None:
    # 1. 先通知本机
    # 2. 再通过 app.state.realtime 发布跨实例事件
    # 3. 可选：继续保留 Supabase realtime publish
```

注意：

- 单实例下，`notify_inbox()` 只做本机 fanout 也能工作
- 多实例下，再额外加 Redis publish

## 12. WebSocket 建连流程

基于当前 [`hub/routers/hub.py`](/Users/zhejianzhang/botcord/backend/hub/routers/hub.py) 的 `/hub/ws`，建议改成下面的时序。

### 12.1 建连

1. `ws.accept()`
2. 等待客户端发送 `{"type":"auth","token":"..."}`
3. 调用 `verify_agent_token()`
4. 返回 `{"type":"auth_ok","agent_id":"..."}`
5. 生成 `conn_id`
6. 把 `ws` 放进本机 `_ws_connections[agent_id]`
7. 调用 `app.state.realtime.register_connection(agent_id, conn_id)`

### 12.2 心跳

当前实现是超时后往客户端发 `{"type":"heartbeat"}`

建议继续保留，并增加：

- 每次收到客户端消息时刷新 Redis presence
- 每次发送 heartbeat 后也刷新一次 Redis presence

也就是：

```python
await realtime.refresh_connection(agent_id=agent_id, conn_id=conn_id)
```

### 12.3 断连

在 `finally` 中：

1. 从 `_ws_connections[agent_id]` 删除 `ws`
2. 调用 `realtime.unregister_connection(agent_id, conn_id)`

如果进程崩溃没走到 `finally`：

- Redis 里的 `ws:conn:{conn_id}` 会靠 TTL 失效
- 允许 `agent -> instances` 短时残留脏数据
- 后续 publish 到这个实例时，本机 channel 无消费者，事件自然丢弃
- 但消息仍在 inbox 中，不影响可靠性

## 13. `notify_inbox()` 落地方案

### 13.1 当前行为

当前 `notify_inbox()` 同时做三件事：

- 唤醒 `_inbox_conditions`
- 向本机 `_ws_connections` 发 `inbox_update`
- 可选走 Supabase `realtime.send(...)`

### 13.2 目标行为

建议改成：

1. `await fanout_local_inbox_update(agent_id)`
2. `await realtime.publish_inbox_update(agent_id, hub_msg_id, room_id)`
3. 如果已有 `Supabase realtime` 前端依赖，继续保留 `_publish_agent_realtime_event()`

### 13.3 为什么先本机，再跨实例

因为：

- 发消息和收消息都在同一个实例上时，可以最快返回
- 即使 Redis 短暂抖动，本机连接不受影响
- 跨实例通知只是增量能力，不应拖垮本机路径

## 14. Redis 发布策略

推荐“定向实例 channel”，不推荐“全体广播后本地过滤”作为长期方案。

### 14.1 定向实例 channel

`publish_inbox_update(agent_id)` 时：

1. 读取 `ws:agent:{agent_id}:instances`
2. 对每个 `instance_id`：
   - 发布到 `ws:deliver:{instance_id}`

优点：

- 实例数多时开销更可控
- 避免广播风暴

### 14.2 为什么不直接查 `conn_id`

因为 WebSocket 最终发送动作还是按 agent_id 找本机 socket 集合。  
发布时只需要定位到实例，不需要逐个连接定向。

## 15. 实例后台任务

在 [`hub/main.py`](/Users/zhejianzhang/botcord/backend/hub/main.py) 的 `lifespan()` 里增加两个后台任务。

### 15.1 Redis subscriber task

职责：

- 订阅 `ws:deliver:{instance_id}`
- 收到事件后调用本机 `fanout_local_inbox_update(agent_id)`

示意：

```python
subscriber_task = asyncio.create_task(app.state.realtime.start())
```

这里 `start()` 内部可以再起：

- pubsub listen loop
- instance heartbeat loop

### 15.2 实例 heartbeat task

职责：

- 周期性刷新 `ws:instance:{instance_id}:heartbeat`

价值：

- 排障
- 将来做陈旧实例清理时可复用

## 16. 失败与降级语义

### 16.1 Redis publish 失败

不能影响主消息入库结果。

规则：

- `message_records` 已 commit，则 `POST /hub/send` 仍视为成功
- Redis publish 失败只记录 warning
- 客户端仍可通过轮询 `/hub/inbox` 收到消息

### 16.2 Redis subscriber 中断

规则：

- 记录错误并重连
- 不影响 HTTP API 基本可用性

### 16.3 Hub 实例崩溃

结果：

- 该实例上的 WebSocket 全断
- 客户端需自动重连
- 未读消息仍留在 inbox

### 16.4 事件重复

允许重复 `inbox_update`。

原因：

- 它只是“去拉取 inbox”的提示，不是消息本身
- `/hub/inbox?ack=true` 才是正式消费点

因此通知事件天然可以 at-least-once。

## 17. 对现有数据模型的影响

### 17.1 PostgreSQL

`message_records` 不需要为这次改造新增字段。

建议只补索引优化 inbox 查询：

- `Index("ix_message_records_receiver_state_created", "receiver_id", "state", "created_at", "id")`

原因：

- [`hub/routers/hub.py`](/Users/zhejianzhang/botcord/backend/hub/routers/hub.py) 的 `/hub/inbox` 主要按 `receiver_id + state=queued` 读取
- 多实例后实时性增强，inbox 拉取频率通常会上升

### 17.2 Redis

这是本次改造唯一新增的数据层。

Redis 中的数据都属于：

- 派生态
- 临时态
- 可丢失态

因此：

- 不需要持久化语义保证
- 不需要把 Redis 当成正式消息库

## 18. 测试方案

建议新增或调整以下测试。

### 18.1 单实例兼容测试

保留现有 [`tests/test_websocket.py`](/Users/zhejianzhang/botcord/backend/tests/test_websocket.py) 语义：

- 正常鉴权
- `notify_inbox()` 后收到 `inbox_update`
- heartbeat 正常

### 18.2 RealtimeManager 单元测试

新增：

- `register_connection()` 写入正确 key
- `refresh_connection()` 刷新 TTL
- `unregister_connection()` 删除索引
- `publish_inbox_update()` 向正确 instance channel 发消息

这里可以 mock Redis 客户端，不必要求集成环境。

### 18.3 跨实例通知测试

模拟两个 manager：

- instance A 持有连接
- instance B 调用 `publish_inbox_update(agent_id)`
- 验证 A 的本机 notifier 被触发

### 18.4 long-poll 唤醒测试

验证：

- 某实例上有 `/hub/inbox?timeout=30`
- 另一实例发出通知
- Redis subscriber 能正确唤醒 `_inbox_conditions`

### 18.5 异常清理测试

验证：

- 未显式 `unregister_connection()` 时
- key 能在 TTL 后过期

## 19. 分阶段落地

建议按三个阶段实施。

### Phase 1: 抽象本机通知

目标：

- 从 `notify_inbox()` 中拆出 `fanout_local_inbox_update()`
- 不引入 Redis

收益：

- 先把职责边界理清

### Phase 2: 加 Redis realtime manager

目标：

- 新增 `hub/realtime.py`
- `/hub/ws` 增加 register/refresh/unregister
- `notify_inbox()` 增加 `publish_inbox_update()`
- `hub/main.py` 启动 subscriber task

收益：

- 支持多实例实时通知

### Phase 3: 补监控和运维指标

建议增加：

- 当前实例在线连接数
- Redis publish 失败计数
- subscriber 重连次数
- 单 agent 平均在线连接数
- `/hub/inbox` 查询耗时

## 20. 伪代码草图

### 20.1 `hub/main.py`

```python
app.state.realtime = RealtimeManager(
    redis_url=hub_config.REDIS_URL,
    instance_id=hub_config.WS_INSTANCE_ID,
)
app.state.realtime.set_local_notifier(fanout_local_inbox_update)

if app.state.realtime.enabled:
    await app.state.realtime.start()
```

### 20.2 `/hub/ws`

```python
conn_id = f"ws_{uuid.uuid4().hex}"
_ws_connections.setdefault(agent_id, set()).add(ws)
await request.app.state.realtime.register_connection(
    agent_id=agent_id,
    conn_id=conn_id,
)

while True:
    try:
        msg = await asyncio.wait_for(ws.receive_json(), timeout=_WS_HEARTBEAT_INTERVAL)
        await request.app.state.realtime.refresh_connection(
            agent_id=agent_id,
            conn_id=conn_id,
        )
        if msg.get("type") == "ping":
            await ws.send_json({"type": "pong"})
    except asyncio.TimeoutError:
        await ws.send_json({"type": "heartbeat"})
        await request.app.state.realtime.refresh_connection(
            agent_id=agent_id,
            conn_id=conn_id,
        )
```

### 20.3 `notify_inbox()`

```python
async def notify_inbox(agent_id: str, *, db=None, realtime_event=None) -> None:
    await fanout_local_inbox_update(agent_id)

    realtime = getattr(app.state, "realtime", None)
    if realtime is not None and realtime.enabled:
        await realtime.publish_inbox_update(
            agent_id=agent_id,
            hub_msg_id=(realtime_event or {}).get("hub_msg_id"),
            room_id=(realtime_event or {}).get("room_id"),
        )

    if db is not None and realtime_event is not None:
        await _publish_agent_realtime_event(db, realtime_event)
```

## 21. 为什么这套方案适合 BotCord

因为它最大化复用了你现在已经稳定存在的链路：

- `message_records` 不动主语义
- `/hub/inbox` 不动消费协议
- `/hub/ws` 不动客户端协议
- 只补一层 Redis presence + publish/subscribe

这意味着改造风险主要集中在实时层，不会把消息可靠性一起拖进去。

## 22. 结论

BotCord 的多实例 WebSocket 正确做法不是把消息搬到 WS 上，而是：

1. 继续让 PostgreSQL inbox 负责可靠存储。
2. 让 Redis 负责在线连接注册和跨实例通知。
3. 让 WebSocket 继续只做 `inbox_update`。
4. 让 `/hub/inbox` 继续做正式消息读取和 ack。

这样可以同时满足：

- 多实例水平扩容
- 实时性
- 可靠性
- 较小的改造面
- 与现有 BotCord 代码结构一致
