# Topic 实体化技术方案

> 版本: v1.0 | 日期: 2026-03-13

## 1. 目标

将 Topic 从 MessageRecord 上的纯字符串字段升级为 **Room → Topic → Message** 层级中的一等实体。Hub 提供 Topic CRUD 接口作为状态存储基础设施，Agent 通过 API 自治管理 Topic 生命周期。

## 2. 变更概览

| 层级 | 文件 | 变更类型 | 说明 |
|------|------|----------|------|
| 枚举 | `hub/enums.py` | 新增 | `TopicStatus` 枚举 |
| ID | `hub/id_generators.py` | 新增 | `generate_topic_id()` |
| 模型 | `hub/models.py` | 新增+修改 | `Topic` 模型 + `MessageRecord` 增加 `topic_id` 列 |
| Schema | `hub/schemas.py` | 新增+修改 | Topic CRUD schema + 现有响应增加 `topic_id` |
| 路由 | `hub/routers/topics.py` | 新增 | Topic CRUD 5 个端点 |
| 路由 | `hub/routers/hub.py` | 修改 | 发送流程集成 Topic 解析/自动创建 |
| 路由 | `hub/routers/dashboard.py` | 修改 | 响应增加 `topic_id` |
| 路由 | `hub/routers/public.py` | 修改 | 响应增加 `topic_id` |
| 入口 | `hub/main.py` | 修改 | 注册 topics_router |
| 转发 | `hub/forward.py` | 不变 | session key 继续用 topic 字符串派生 |
| 重试 | `hub/retry.py` | 不变 | 透传 topic 字符串 |
| 签名 | `hub/crypto.py` | 不变 | 签名用信封中的 topic 字符串 |
| 测试 | `tests/` | 新增+修改 | Topic CRUD 测试 + 现有测试适配 |
| 文档 | `doc/` | 修改 | topic-lifecycle-design.md、CLAUDE.md |

---

## 3. 各层级详细方案

### 3.1 枚举层：`hub/enums.py`

新增 `TopicStatus` 枚举：

```python
class TopicStatus(str, enum.Enum):
    open = "open"
    completed = "completed"
    failed = "failed"
    expired = "expired"
```

---

### 3.2 ID 生成层：`hub/id_generators.py`

新增：

```python
def generate_topic_id() -> str:
    """Generate topic_id: 'tp_' + 12 random hex chars."""
    return "tp_" + secrets.token_hex(6)
```

---

### 3.3 模型层：`hub/models.py`

#### 3.3.1 新增 `Topic` 模型

```python
class Topic(Base):
    __tablename__ = "topics"
    __table_args__ = (
        UniqueConstraint("room_id", "title", name="uq_room_topic_title"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    topic_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    room_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("rooms.room_id"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[TopicStatus] = mapped_column(
        Enum(TopicStatus), nullable=False, default=TopicStatus.open
    )
    creator_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.agent_id"), nullable=False
    )
    goal: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    closed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    room: Mapped["Room"] = relationship(back_populates="topics")
```

#### 3.3.2 修改 `Room` 模型

增加 `topics` relationship：

```python
class Room(Base):
    # ... 现有字段 ...
    topics: Mapped[list["Topic"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )
```

#### 3.3.3 修改 `MessageRecord` 模型

新增 `topic_id` 列，**保留**现有 `topic` 字符串列：

```python
class MessageRecord(Base):
    # ... 现有字段 ...
    topic: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)      # 保留
    topic_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)    # 新增
```

> **注意**：`topic_id` 不设 ForeignKey 约束。原因：MessageRecord 中的消息可能对应已被删除的 Topic，加 FK 会导致级联问题。通过应用层保证一致性。

---

### 3.4 Schema 层：`hub/schemas.py`

#### 3.4.1 新增 Topic schemas

```python
class CreateTopicRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)
    description: str | None = None
    goal: str | None = Field(default=None, max_length=1024)

class UpdateTopicRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=256)
    description: str | None = None
    status: TopicStatus | None = None
    goal: str | None = Field(default=None, max_length=1024)

class TopicResponse(BaseModel):
    topic_id: str
    room_id: str
    title: str
    description: str | None = None
    status: str
    creator_id: str
    goal: str | None = None
    message_count: int
    created_at: datetime.datetime
    updated_at: datetime.datetime | None = None
    closed_at: datetime.datetime | None = None

class TopicListResponse(BaseModel):
    topics: list[TopicResponse]
```

#### 3.4.2 修改现有 schemas

以下 schema 新增 `topic_id: str | None = None` 字段：

| Schema | 用途 |
|--------|------|
| `InboxMessage` | 轮询收件箱 |
| `HistoryMessage` | 历史查询 |
| `DashboardMessage` | Dashboard 消息 |
| `SendResponse` | 发送响应（让调用者知道 topic 被解析/创建为哪个 topic_id） |

`SendResponse` 修改：

```python
class SendResponse(BaseModel):
    queued: bool
    hub_msg_id: str
    status: str
    topic_id: str | None = None      # 新增
```

---

### 3.5 路由层

#### 3.5.1 新增 `hub/routers/topics.py`

路由前缀：`/hub/rooms/{room_id}/topics`

| 方法 | 路径 | Auth | 说明 | 权限 |
|------|------|------|------|------|
| POST | `/hub/rooms/{room_id}/topics` | JWT | 创建 topic | 房间成员 |
| GET | `/hub/rooms/{room_id}/topics` | JWT | 列出 topics | 房间成员，支持 `?status=` 过滤 |
| GET | `/hub/rooms/{room_id}/topics/{topic_id}` | JWT | 获取详情 | 房间成员 |
| PATCH | `/hub/rooms/{room_id}/topics/{topic_id}` | JWT | 更新状态/标题/描述 | 状态更新：任意成员；标题/描述：creator/admin/owner |
| DELETE | `/hub/rooms/{room_id}/topics/{topic_id}` | JWT | 删除 topic | owner/admin |

**权限校验逻辑**（所有端点共用）：

```python
async def _require_room_member(room_id: str, agent_id: str, db: AsyncSession) -> RoomMember:
    """校验 agent 是否为 room 成员，返回 RoomMember 记录。"""
```

**状态转换规则**：

```
open       → completed / failed     （任意成员）
completed  → open                   （任意成员，需提供新 goal）
failed     → open                   （任意成员，需提供新 goal）
expired    → open                   （任意成员，需提供新 goal）
```

#### 3.5.2 修改 `hub/routers/hub.py`

**核心变更**：新增 `_resolve_or_create_topic()` 辅助函数。

```python
async def _resolve_or_create_topic(
    room_id: str,
    topic_title: str,
    creator_id: str,
    goal: str | None,
    msg_type: MessageType,
    db: AsyncSession,
) -> str:
    """
    根据 (room_id, topic_title) 查找或自动创建 Topic。返回 topic_id。

    行为：
    1. 查找 Topic(room_id=room_id, title=topic_title)
    2. 不存在 → 创建，status=open，返回 topic_id
    3. 存在 + msg_type=result → 更新 status=completed
    4. 存在 + msg_type=error → 更新 status=failed
    5. 存在 + status 已终止 + 有新 goal → 重新激活为 open
    6. 递增 message_count，更新 updated_at
    """
```

**集成点**（3 处）：

| 函数 | 位置 | 说明 |
|------|------|------|
| `_send_direct_message()` | `_ensure_dm_room()` 之后 | 如有 effective_topic，调用 `_resolve_or_create_topic()` |
| `_send_room_message()` | fan-out 循环之前 | 如有 effective_topic，调用 `_resolve_or_create_topic()`（只调一次） |
| `receive_receipt()` | 创建 receipt 记录时 | 继承原消息的 topic_id；如 type=result/error，更新 Topic 状态 |

**MessageRecord 创建**：所有创建 MessageRecord 的地方增加 `topic_id=topic_id`。

**查询端点修改**：

| 端点 | 修改 |
|------|------|
| `GET /hub/inbox` | 响应中增加 `topic_id`（从 `MessageRecord.topic_id` 读取） |
| `GET /hub/history` | 新增 `topic_id` query 参数；响应中增加 `topic_id` |

`GET /hub/history` 过滤逻辑：

```python
# topic_id 精确过滤（新增）
if topic_id is not None:
    stmt = stmt.where(MessageRecord.topic_id == topic_id)

# topic 字符串过滤（保留，向后兼容）
if topic is not None:
    stmt = stmt.where(MessageRecord.topic == topic)
```

#### 3.5.3 修改 `hub/routers/dashboard.py`

`DashboardMessage` 构建处增加 `topic_id=rec.topic_id`。

#### 3.5.4 修改 `hub/routers/public.py`

同上，public 消息响应中增加 `topic_id`。

---

### 3.6 入口层：`hub/main.py`

```python
from hub.routers.topics import router as topics_router
# ...
app.include_router(topics_router)
```

---

### 3.7 不需要修改的层级

| 文件 | 原因 |
|------|------|
| `hub/forward.py` | session key 继续用 `topic` 字符串派生，保持 OpenClaw 会话稳定性 |
| `hub/retry.py` | 透传 `record.topic` 字符串给 forward 函数，不涉及 topic_id |
| `hub/crypto.py` | 签名输入用信封中的 `topic` 字符串，topic_id 是 Hub 内部概念 |
| `hub/auth.py` | 不涉及 |
| `hub/config.py` | 不涉及 |
| `hub/constants.py` | 不涉及 |
| `hub/cleanup.py` | 不涉及（Topic 过期可后续通过扩展此文件实现） |
| `hub/validators.py` | 不涉及 |
| `MessageEnvelope` | 信封中 `topic` 仍为字符串，是协议层概念；`topic_id` 是 Hub 存储层概念 |

---

## 4. 协议与存储的边界

```
┌─────────────────────────────────────────────────────┐
│  协议层 (MessageEnvelope)                            │
│                                                     │
│  topic: "翻译README"    ← 字符串，Agent 可读，参与签名  │
│  goal:  "将 README 翻译为中文"                        │
│                                                     │
├─────────────────────────────────────────────────────┤
│  Hub 存储层 (Topic 实体)                              │
│                                                     │
│  topic_id: "tp_a1b2c3d4e5f6"  ← Hub 内部标识符       │
│  room_id:  "rm_xxx"                                 │
│  title:    "翻译README"        ← 等于信封中的 topic    │
│  status:   "open"              ← Agent 通过 API 管理  │
│  goal:     "将 README 翻译为中文"                      │
│                                                     │
├─────────────────────────────────────────────────────┤
│  消息记录 (MessageRecord)                             │
│                                                     │
│  topic:    "翻译README"        ← 保留，向后兼容        │
│  topic_id: "tp_a1b2c3d4e5f6"  ← 新增，关联 Topic 实体  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**映射规则**：`Topic.title` = `MessageEnvelope.topic` = `MessageRecord.topic`。同一 Room 内 title 唯一。

---

## 5. 向后兼容性

| 维度 | 兼容策略 |
|------|----------|
| 协议信封 | `topic` 字段不变，仍为字符串。不引入 `topic_id` 到信封 |
| 发送 API | `?topic=` query param 继续有效。Hub 内部将字符串解析为 topic_id |
| 历史查询 | `?topic=` 字符串过滤继续有效，新增 `?topic_id=` 作为替代 |
| 响应结构 | 所有现有字段保留，`topic_id` 作为新增可选字段 |
| OpenClaw 转发 | session key 用 topic 字符串派生，不变 |
| 签名 | topic 字符串参与签名，topic_id 不参与 |
| 旧消息 | `topic_id` 为 NULL，不影响查询 |

---

## 6. 实现顺序

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **Phase 1** | enums.py + id_generators.py + models.py（Topic 模型 + MessageRecord 新列） | 无 |
| **Phase 2** | schemas.py（Topic CRUD schema + 现有 schema 扩展） | Phase 1 |
| **Phase 3** | routers/topics.py + main.py 注册 | Phase 2 |
| **Phase 4** | routers/hub.py（`_resolve_or_create_topic` + 发送/收据/查询集成） | Phase 3 |
| **Phase 5** | routers/dashboard.py + routers/public.py（响应增加 topic_id） | Phase 2 |
| **Phase 6** | 测试（新增 + 适配） | Phase 4 |
| **Phase 7** | 文档更新（topic-lifecycle-design.md、CLAUDE.md） | Phase 6 |

---

## 7. 测试计划

### 7.1 新增测试文件

**`tests/test_topics.py`**：Topic CRUD 端点测试

- 创建 topic（正常、重复 title、非成员拒绝）
- 列出 topics（全部、按 status 过滤、空列表）
- 获取 topic 详情（正常、不存在 404、非成员 403）
- 更新 topic（状态转换、标题修改、权限校验）
- 删除 topic（owner/admin 可删、member 不可删）
- 状态转换完整性（open→completed→open 重新激活）

### 7.2 修改现有测试

| 文件 | 修改内容 |
|------|----------|
| `tests/test_room.py` | topic 相关测试断言增加 `topic_id` 字段 |
| `tests/test_m3_hub.py` | 发送/收据/历史响应断言增加 `topic_id` |
| `tests/test_topic_lifecycle.py` | 适配 Hub 侧 Topic 实体（不再是 Agent 本地状态） |

---

## 8. 数据库迁移（生产环境）

现有数据中 `MessageRecord.topic` 为纯字符串，需要迁移脚本：

1. 扫描所有 `(room_id, topic)` 非空的唯一组合
2. 为每个组合创建 `Topic` 记录（`creator_id` 取该组合最早消息的 `sender_id`）
3. 回填 `MessageRecord.topic_id`
4. 无 `room_id` 的消息（早期 DM）跳过，`topic_id` 保持 NULL

> 注：测试环境使用 SQLite 内存库，每次 `create_all` 自动建表，无需迁移。
