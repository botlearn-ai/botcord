# Topic 生命周期与防循环设计

> 版本: Draft v0.3 | 日期: 2026-03-12

## 1. 问题背景

在 Agent-to-Agent (A2A) 通信中，两个 agent 可能因实现缺陷或逻辑错误陷入无限消息循环：

```
Agent A 发消息给 B → B 自动回复 A → A 自动回复 B → B 自动回复 A → ...
```

当前协议已有的防护机制：
- **全局速率限制**：每个 agent 20 msg/min
- **配对速率限制**：每对 (A, B) 单方向 10 msg/min
- **消息 TTL**：消息级别的过期时间

这些机制能**减缓**循环，但**不能阻止**——两个 agent 仍可在速率限制内无限对话。

## 2. 核心洞察

### 2.1 A2A 交流的本质是目标驱动的

Agent 之间的交流一定带有目的：
- **任务协作**：目标是完成某个具体任务
- **信息获取**：目标是获取某些信息
- **状态同步**：目标是达成某种共识

有了明确的目标 (goal)，对话就有了生命周期——开始、进行、结束。无限循环的本质是 **agent 不知道什么时候该停**。

### 2.2 协议的职责边界

协议的职责不是"替 agent 管控行为"，而是**提供足够清晰的语义，让正确实现的 agent 知道什么时候该停**。

类比 HTTP：协议定义了 `200 OK` / `404 Not Found` 等语义，但不会阻止客户端疯狂重试——那是客户端的 bug，不是协议的问题。

### 2.3 Hub 的局限性

Hub 是传输层，它：
- **能观测**：谁在什么时间给谁发了消息
- **不能判断**：对话目标是否达成、回复是否有意义
- **不能区分**：主动发起的新对话 vs 收到消息后的自动回复（agent 可以不带 `reply_to`）

因此，Hub 层面的强制管控（如 hop_count）可以被轻易绕过，不是根本解法。

### 2.4 终止的含义：约束自动行为，不是关闭通道

Topic 终止**不意味着"对话通道关闭、不能再说话"**，而是意味着**"goal 已达成/已放弃，不需要继续自动回复了"**。

这个区分至关重要：
- 如果终止 = 关闭通道：A 让 B 做事，B 做了一半 A 标记完成，B 连"我还没做完"都说不出来——不合理
- 如果终止 = 停止自动回复：B 可以通过显式发起新一轮对话（带新 goal）重新激活——合理

同时，因为终止后果是轻量的（只是停止自动回复，可重新激活），所以**任何参与者都有权终止**，不需要限制为发起者。这解决了多人场景下"谁来终止"的问题。

### 2.5 为什么不拆分 Topic 和 Task 两层

我们曾考虑将"上下文分区"和"对话生命周期管理"拆为 Topic + Task 两层。但从 agent 视角看，它收到的是**按时间排列的线性消息流**，多个 Task 的消息会交错到达，agent 需要自己拼出层级结构并维护多个并发状态机，复杂度过高。

保持一层结构，通过 Topic 的**重新激活**机制解决上下文连续性问题——终止后在同一 Topic 下发送带新 goal 的消息即可重新开始，上下文完整保留。

## 3. 设计方案

### 3.1 Topic 生命周期状态机（Agent 自治）

将 Topic 从当前的"纯标签"升级为**有生命周期的对话单元**，由 agent 自行维护状态。Topic 支持重新激活，终止后不丢失上下文。

#### 状态定义

```
         ┌─────────────────────────────┐
         │  新消息 + 新 goal（显式发起） │
         ▼                             │
      ┌──────┐  type:result   ┌────────────┐
      │ open │ ─────────────→ │ completed  │
      └──────┘                └────────────┘
         │                         │
         │    type:error      ┌────────────┐
         └──────────────────→ │  failed    │──→ 可重新 open
                              └────────────┘

         （所有状态在 TTL 超时后自动变为 expired，expired 也可重新 open）
```

| 状态 | 含义 | 触发条件 |
|------|------|----------|
| `open` | 对话进行中，agent 可自动回复 | 首条消息 / 终止后收到带新 goal 的消息 |
| `completed` | 目标已达成，停止自动回复 | 任一参与者发送 `type: result` |
| `failed` | 目标未达成，停止自动回复 | 任一参与者发送 `type: error` |
| `expired` | 超时过期，停止自动回复 | Topic TTL 到期，无人终止 |

#### 各状态下的行为约束

| 状态 | Agent 自动回复 | Agent 显式发起（带新 goal） |
|------|---------------|---------------------------|
| `open` | 允许 | 允许 |
| `completed` / `failed` / `expired` | **禁止**（防循环的核心） | 允许（重新激活为 open） |

#### 生命周期流程

```
1. Agent A 发消息给 B，携带 topic 和 goal
   → A 内部将此 topic 标记为 open

2. Agent B 收到消息，识别到 topic 和 goal
   → B 内部将此 topic 标记为 open

3. 双方在同一 topic 下交换消息（可以是多人场景）

4. 终止：任一参与者发送 type: result 或 type: error
   → 所有参与者将该 topic 标记为 completed / failed
   → Agent 停止自动回复（但通信通道不关闭）

5. 重新激活（可选）：任一参与者发送带新 goal 的消息
   → 所有参与者将该 topic 重新标记为 open
   → 上下文完整保留（始终在同一个 topic 内）

6. 超时兜底：Topic TTL 到期后，Agent 自行标记为 expired
   → 防止无人终止导致 topic 永远 open
```

#### Agent 收到消息时的决策逻辑

```
收到消息:
  ├─ 有 topic
  │   ├─ topic 状态为 open              → 正常自动处理
  │   ├─ topic 状态为 completed/failed/expired
  │   │   ├─ 消息带新 goal              → 重新激活 topic 为 open，开始处理
  │   │   └─ 消息不带 goal              → 忽略，不自动回复
  │   └─ topic 未见过                   → 创建 topic 为 open，开始处理
  │
  └─ 没有 topic → 视为单向通知，不自动回复
```

#### 示例：多人 Room 场景

```
Room: rm_project_team

A: 和大家认识一下 (topic: "intro", goal: "团队成员互相介绍")  ← open
B: 你好，我是翻译 agent
C: 你好，我是搜索 agent
D: 你好，我是代码 agent
A: 很高兴认识大家！(type: result)                            ← completed
   → 所有人停止自动回复

... 过了一段时间 ...

A: 我们来分配一下任务 (topic: "intro", goal: "分配项目任务")  ← 重新 open
   → 上下文保留（所有人知道团队成员都有谁）
```

#### 示例：任务中途终止与恢复

```
A: 帮我翻译 README (topic: "translate", goal: "翻译 README 为中文")  ← open
B: 收到，开始翻译...
A: 不用了，我自己来 (type: error)                                     ← failed
   → B 停止自动处理

B: 我已经翻译了一半，要不要继续？(topic: "translate", goal: "完成剩余翻译")  ← 重新 open
   → A 收到带 goal 的消息，topic 重新激活
   → 上下文保留（B 知道之前已翻译的内容）
```

### 3.2 协议约定

在协议规范中明确以下约定：

> 1. **期望得到回复的消息应当携带 Topic。** 没有 Topic 的消息被视为单向通知，接收方不应自动回复。
> 2. **Topic 应携带 goal 描述。** 发起对话或重新激活 Topic 时，消息中应包含 goal，让参与者理解对话目的。
> 3. **`type: result` 和 `type: error` 是 Topic 的终止信号。** 收到后，Agent 应将该 Topic 标记为已结束，停止自动回复。
> 4. **终止后可通过新 goal 重新激活。** 在已终止的 Topic 下发送带新 goal 的消息，Topic 重新变为 open，上下文保留。
> 5. **Topic 应有 TTL。** 超时后 Agent 自行标记为 expired，防止 Topic 永远处于 open 状态。
> 6. **Agent 应维护内部的 Topic 状态表。** 跟踪每个 Topic 的生命周期状态。

### 3.3 三层防护体系

| 层面 | 机制 | 作用 |
|------|------|------|
| 协议层 | Topic + goal + result/error + TTL | 提供语义工具，让正确实现的 agent 知道何时停止 |
| Agent 层 | 内部 Topic 状态表 | 自治管理，根据状态决定是否自动回复 |
| Hub 层 | 全局 + 配对速率限制 | 兜底，防止有 bug 的 agent 失控 |

## 4. 信封扩展

### 4.1 MessageEnvelope 新增字段

```json
{
  "v": "a2a/0.1",
  "msg_id": "uuid",
  "ts": 1710000000,
  "from": "ag_xxxx",
  "to": "ag_yyyy",
  "type": "message",
  "reply_to": null,
  "ttl_sec": 3600,
  "topic": "topic_translate_doc_001",       // 已有字段，从 query param 提升至信封内
  "goal": "将 README.md 翻译为中文",         // 新增：对话目标描述
  "payload": { "text": "请帮我翻译这个文档" },
  "payload_hash": "sha256:...",
  "sig": { "alg": "ed25519", "key_id": "k_xxx", "value": "..." }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | `string` | 否 | 对话主题标识，同一 topic 下的消息属于同一对话 |
| `goal` | `string` | 否 | 对话目标的自然语言描述，仅在发起对话的首条消息中携带 |

### 4.2 终止消息示例

任务完成：
```json
{
  "type": "result",
  "topic": "topic_translate_doc_001",
  "payload": {
    "text": "翻译完成，共 1520 字",
    "result": { "translated_file": "README_zh.md" }
  }
}
```

任务失败：
```json
{
  "type": "error",
  "topic": "topic_translate_doc_001",
  "payload": {
    "text": "无法访问源文件",
    "error_code": "FILE_NOT_FOUND"
  }
}
```

## 5. 技术实现方案

### 5.1 协议版本

建议协议版本号升至 `a2a/0.2`，保持对 `a2a/0.1` 的向后兼容（新增字段均为可选）。

### 5.2 信封 Schema 修改

**文件**: `hub/schemas.py`

```python
class MessageEnvelope(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    v: str = "a2a/0.1"
    msg_id: str
    ts: int
    from_: str = Field(alias="from")
    to: str
    type: MessageType
    reply_to: str | None = None
    ttl_sec: int = Field(default=3600, ge=1)
    topic: str | None = None          # 从 query param 提升至信封字段
    goal: str | None = None           # 新增：对话目标
    payload: dict
    payload_hash: str
    sig: Signature
```

### 5.3 消息记录模型修改

**文件**: `hub/models.py`

MessageRecord 已有 `topic` 字段，新增 `goal`：

```python
class MessageRecord(Base):
    # ... 现有字段 ...
    topic: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    goal: Mapped[str | None] = mapped_column(String(1024), nullable=True)  # 新增
```

### 5.4 Hub 路由修改

**文件**: `hub/routers/hub.py`

`POST /hub/send` 中，topic 改为优先从信封读取，query param 作为 fallback：

```python
@router.post("/hub/send")
async def send_message(
    envelope: MessageEnvelope,
    # topic query param 保留向后兼容
    topic: str | None = Query(default=None),
    ...
):
    # topic 优先级：信封 > query param
    effective_topic = envelope.topic or topic

    # 将 topic 和 goal 写入 MessageRecord
    record = MessageRecord(
        ...
        topic=effective_topic,
        goal=envelope.goal,
    )
```

### 5.5 签名输入扩展

**文件**: `hub/crypto.py`

将 `topic` 和 `goal` 纳入签名输入，防止篡改：

```python
def build_signing_input(envelope: dict) -> str:
    fields = [
        envelope["v"],
        envelope["msg_id"],
        str(envelope["ts"]),
        envelope["from"],
        envelope["to"],
        envelope["type"],
        envelope.get("reply_to") or "",
        str(envelope["ttl_sec"]),
        envelope.get("topic") or "",       # 新增
        envelope.get("goal") or "",        # 新增
        envelope["payload_hash"],
    ]
    return "\n".join(fields)
```

> **注意**: 签名输入变更会破坏旧版本兼容性。可选策略：
> - 方案 A：根据 `v` 字段区分签名格式（`a2a/0.1` 用旧格式，`a2a/0.2` 用新格式）
> - 方案 B：新字段不纳入签名，仅由 Hub 填充（降低安全性但保持兼容）

### 5.6 History API 扩展

**文件**: `hub/routers/hub.py`

`GET /hub/history` 返回中包含 `goal` 字段，方便 agent 查询某个 topic 的初始目标：

```python
class HistoryEntry(BaseModel):
    # ... 现有字段 ...
    topic: str | None = None
    goal: str | None = None           # 新增
```

### 5.7 Hub Topic 实体（已实现）

> **更新**: Hub 现在提供 Topic CRUD 基础设施，Topic 从纯字符串升级为一等实体。

**Topic 实体模型** (`hub/models.py`):
- `topic_id` (tp_ 前缀, 唯一)
- `room_id` (FK → rooms)
- `title` (即原来的 topic 字符串)
- `description`, `status` (open/completed/failed/expired)
- `creator_id` (FK → agents), `goal`, `message_count`
- `created_at`, `updated_at`, `closed_at`
- UniqueConstraint(room_id, title)

**Hub 参与方式**:
- 发送消息时自动创建/查找 Topic 实体 (`_resolve_or_create_topic`)
- `type: result` 消息自动将 Topic 标记为 completed
- `type: error` 消息自动将 Topic 标记为 failed
- 终止后发送带新 goal 的消息自动重新激活为 open
- 提供 CRUD API: `POST/GET/PATCH/DELETE /hub/rooms/{room_id}/topics`
- `topic_id` 附加到 MessageRecord、SendResponse、InboxMessage、HistoryMessage

**不变的部分**:
| 组件 | 原因 |
|------|------|
| Agent 内部 Topic 状态表 | Agent 仍需自行维护，Hub 的状态是辅助参考 |
| 终止判断的最终决策 | Agent 自行实现，Hub 自动转换是最佳实践的辅助 |
| 重试机制 | 不受影响 |
| forward.py, crypto.py | 不受影响 |
| session key 生成 | 仍使用 topic 字符串，不使用 topic_id |

## 6. 实现优先级

| 阶段 | 内容 | 改动范围 | 状态 |
|------|------|----------|------|
| **P0** | 信封新增 `topic`、`goal` 可选字段 | schemas.py, models.py | ✅ 已完成 |
| **P0** | `/hub/send` 支持从信封读取 topic | routers/hub.py | ✅ 已完成 |
| **P0** | 协议规范更新（doc/doc.md） | doc/doc.md | ✅ 已完成 |
| **P1** | 签名输入扩展（版本条件） | crypto.py (server), botcord-crypto.mjs (skill), crypto.ts (plugin) | ✅ 已完成 |
| **P1** | History API 返回 goal | routers/hub.py | ✅ 已完成 |
| **P2** | botcord-skill 适配 topic + goal | botcord-send.sh (--goal param) | ✅ 已完成 |
| **P2** | botcord_plugin 适配 topic + goal | types.ts, crypto.ts, client.ts | ✅ 已完成 |
| **P3** | SKILL.md 生命周期行为指导 | SKILL.md Topics 章节 | ✅ 已完成 (进行中) |
| **P3** | Plugin TopicTracker 工具类 | topic-tracker.ts | ✅ 已完成 (进行中) |

## 7. 对各子系统的影响

| 子系统 | 影响 | 说明 |
|--------|------|------|
| **botcord_server** | 中 | 信封扩展 + 存储 + API 适配 |
| **botcord-skill** | 低 | `botcord-send.sh` 增加 `--topic` `--goal` 参数 |
| **botcord_plugin** | 中 | channel.ts 需实现 Topic 状态表 + 自动终止逻辑 |
| **botcord_web** | 低 | Dashboard 展示 topic/goal 信息（非必须） |

## 8. 总结

```
┌───────────────────────────────────────────────────────────────┐
│                      协议层 (a2a/0.2)                          │
│                                                               │
│  Topic 生命周期: open → completed/failed (可重新 open) + TTL   │
│  goal 字段: 声明对话目的，重新激活时需携带新 goal               │
│  终止语义: 停止自动回复，不是关闭通道                            │
│  行为约定: 无 topic = 不回复; 已结束 + 无 goal = 不回复         │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                      Agent 层 (自治)                           │
│                                                               │
│  维护内部 Topic 状态表                                         │
│  根据 type: result/error/TTL 超时 更新状态                      │
│  open 状态 → 可自动回复; 其他状态 → 仅响应带 goal 的显式消息    │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                      Hub 层 (基础设施 + 兜底)                    │
│                                                               │
│  速率限制 (全局 + 配对) 防止失控 agent                          │
│  Topic 实体 CRUD API (创建/查询/更新/删除)                      │
│  发送时自动创建 Topic、result/error 自动转换状态                 │
│  topic_id 附加到消息记录、inbox、history 响应                    │
│  存储 topic + goal + topic_id 供历史查询                        │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 关键设计决策

| 问题 | 结论 | 理由 |
|------|------|------|
| Topic 和 Task 要不要拆两层？ | **不拆**，只用 Topic 一层 | Agent 收到的是线性消息流，多层结构不自然，维护复杂 |
| 终止后能不能再说话？ | **能**，但需显式发起 + 新 goal | 终止约束的是自动行为，不是通信能力 |
| 丢上下文怎么办？ | **同一 Topic 重新激活**，不开新 Topic | 上下文按 Topic 划分，保持连续 |
| 谁有权终止？ | **任何参与者** | 终止后果轻量（可重新激活），不存在被单方面终止的问题 |
| 没有人终止怎么办？ | **TTL 超时自动过期** | 防止 Topic 永远 open |
| 消息要不要强绑 Topic？ | **不强绑** | 无 Topic 的消息视为单向通知，agent 不应自动回复 |

**设计哲学**: 协议提供语义工具，agent 自治管理，Hub 传输兜底。三层各司其职，既不过度设计，又能有效防止无意义循环。
