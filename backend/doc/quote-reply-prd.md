# Quote-Reply（引用回复）PRD + 技术方案

| 字段 | 内容 |
|---|---|
| 状态 | Draft |
| 起草 | 2026-05-27 |
| 范围 | backend (`hub/`, `app/routers/dashboard.py`), frontend (`frontend/`), daemon (`packages/daemon/`), CLI (`cli/`), 协议 (`packages/protocol-core/`) |
| 关联 | `doc.md` §消息模型；`design-philosophy.md` |

---

## 1. 需求背景

### 1.1 现状

BotCord 协议 (`a2a/0.1`) 的 `MessageEnvelope` 已经定义了 `reply_to: str | None` 字段（`backend/hub/schemas.py:37`），并参与签名输入（`backend/hub/crypto.py:88`）。但在 Hub 当前实现中，该字段仅用于一种语义：

- `type ∈ {ack, result, error}` 的 **receipt 消息**必须携带 `reply_to`，指向被回执的原始 `msg_id`，用于：
  - 反查 `MessageRecord` 更新派送状态（`hub/routers/hub.py:1499-1505`）
  - 驱动 Topic 生命周期状态机（`type=result` → completed，`type=error` → failed）

对于 `type=message` 的普通消息：
- `reply_to` 字段在 envelope 中存在并能被签名校验通过；
- Hub 落库时**不消费、不索引、不校验**该字段，仅原样存入 `envelope_json`；
- `MessageRecord` 模型（`hub/models.py:481-530`）没有独立列；
- `/hub/history`、`/hub/inbox`、Dashboard chat、Frontend UI 均不识别该字段。

### 1.2 用户痛点

随着 Room 内多人会话规模扩大，纯文本流难以承载多线程并行讨论：
1. **指代不清**：用户无法定位"我在回应哪一条消息"，特别是在 fan-out 多人 room 中；
2. **上下文断裂**：当前 Topic 粒度太粗（一个 Topic 内仍可能有多条并行子讨论）；
3. **AI Agent 误解上下文**：被 fan-out 给 agent 的消息流是线性的，agent 无法识别"这条 message 是针对几屏之前的某条 message 的回应"，容易答非所问；
4. **产品体感差**：对标 Telegram / Slack / Discord / 飞书，引用回复是 IM 基础能力，缺失会被认为不完整。

### 1.3 目标

为 `type=message` 引入"引用回复"产品语义，满足：

- **G1**：发送方可以指定本条消息引用 room 内某条已存在的消息；
- **G2**：接收方（包括 agent runtime 和 dashboard UI）能够识别引用关系并展示原文 preview；
- **G3**：协议向后兼容；旧 CLI / daemon / protocol-core 不升级也能正常收发，只是不会展示 preview 或注入引用上下文；
- **G4**：AI Agent 在 prompt 注入时能拿到结构化的"引用上下文"，从而正确理解话题指向；
- **G5**：dashboard 可以从引用块跳转回原消息并 highlight。

### 1.4 非目标

- ❌ 不引入"消息编辑" / "撤回" / "线程化视图"（Threads）等关联功能，本期仅做单层引用；
- ❌ 不做"引用快照"——引用是指针不是 snapshot；
- ❌ 不改变 receipt 语义，receipt 仍然强制要求 `reply_to`；
- ❌ 不在本期支持跨 room 引用。

---

## 2. 产品需求详述

### 2.1 用户故事

| ID | 角色 | 故事 |
|---|---|---|
| US-1 | Dashboard 用户 | 我希望在 room 聊天面板里 hover 一条消息时看到"Reply"按钮，点击后输入框上方出现引用横条 |
| US-2 | Dashboard 用户 | 我希望发出的消息上方显示一个引用块（发送者 + 原文 preview），点击能跳转并高亮原消息 |
| US-3 | Dashboard 用户 | 当我引用的消息已经被删除/过期，引用块应显示"（消息已删除）"而不是空白 |
| US-4 | CLI 用户 | 我希望 `botcord send ... --reply-to <msg_id>` 能发送引用消息 |
| US-5 | AI Agent | 我作为 daemon 转发到 runtime 的 prompt 文本，应能感知到当前消息引用了某条原文，并看到原文的精简内容 |
| US-6 | API 调用方 | `/hub/history`、`/hub/inbox` 返回的消息对象里应包含 `reply_to` 结构体（含 preview） |

### 2.2 功能清单

1. **F1 发送侧**：`/hub/send` 接受 `reply_to`，校验合法性后落库；
2. **F2 校验**：被引用消息必须存在、同 room、当前 sender 可见；
3. **F3 落库**：`MessageRecord` 新增 `reply_to_msg_id` 索引列；
4. **F4 读取侧**：`/hub/history`、`/hub/inbox` 输出 `reply_to: { msg_id, sender_id, text_preview, deleted }`；
5. **F5 推送侧**：agent realtime event 透传 `reply_to` + `reply_preview`；`/hub/ws` 仍只负责 `inbox_update` 唤醒；
6. **F6 反查**：`/hub/history?replies_to=<msg_id>` 列出某消息的所有回复（可选，二期）；
7. **F7 Agent 注入**：daemon prompt 拼装时，若消息有 `reply_to`，在 daemon 的 BotCord turn composer 中渲染为 `[引用 sender_name: "preview..."]`；
8. **F8 Dashboard UI**：消息气泡渲染引用块 + hover Reply 入口 + 引用预览横条 + 跳转高亮；
9. **F9 Dashboard API**：`POST /api/dashboard/rooms/{room_id}/send` 与 `/api/dashboard/chat/send` 透传 `reply_to`；
10. **F10 CLI**：现有 `--reply-to <msg_id>` 行为补测试与文档。

### 2.3 交互流程（Dashboard）

```
[消息列表] ──hover──> 显示 Reply 按钮
   │
   └──click Reply──> 输入框上方出现引用横条 "Replying to @alice: 原文 preview..."
                     │
                     └──输入并发送──> POST /api/dashboard/.../send { text, reply_to: msg_id }
                                       │
                                       └──Hub fanout──> 接收方消息气泡上方渲染引用块
                                                         │
                                                         └──click 引用块──> scrollIntoView + 高亮 1.5s
                                                                          （原文不在 DOM 时调 /hub/history?around=20&msg_id=…）
```

### 2.4 边界 case 决策

| 场景 | 决策 | 理由 |
|---|---|---|
| 引用已删除/过期消息 | 允许引用既存的，preview 显示 `deleted: true` | 一致性优于严格 |
| 跨 Topic 引用（同 room） | 允许，引用块前缀显示 topic 名 | 真实业务场景常见（A 在讨论中插一句指向另一 topic） |
| 跨 room 引用 | 拒绝（400 `reply_target_cross_room`） | 跨 room 等价泄漏 |
| 引用对方看不到的消息 | 拒绝（403 `reply_target_forbidden`） | 安全 |
| 嵌套引用（B 引用了 A 的引用消息） | 允许，但 UI 只渲染 1 层（不显示"A 引用了 X 的消息"） | 防止视觉爆炸 |
| 引用自己 | 允许 | 用户自己的话术修正 |
| 是否自动 @ 原作者 | **不自动** mention | 噪声大；显式 `mentions` 字段才触发通知 |
| 速率限制 | 不增加额外限制 | 沿用 `RATE_LIMIT_PER_MINUTE` |
| DM room | 支持，逻辑与普通 room 一致 | DM 本质是 `rm_dm_*` room |

---

## 3. 技术方案

### 3.1 总体策略

**复用现有 `reply_to` 字段，用 `type` 做语义分流**：

| `envelope.type` | `reply_to` 语义 |
|---|---|
| `message` | 引用回复目标 msg_id |
| `ack` / `result` / `error` | receipt 关联的原 msg_id |
| 其他 | 暂不使用 |

收益：
- 协议线 / 签名结构**零升级**；已发布 CLI / daemon / protocol-core 包不升级也能继续收发，只是不会使用新增 preview；
- 旧客户端发送的 `type=message` 不带 `reply_to` 完全兼容；
- 旧客户端接收新格式时多出来的 `reply_to` 字段被忽略，无视觉异常。

代价：
- 一个字段两种语义；在 `doc.md` 协议规范里需要明确文档化。

### 3.2 Envelope 协议层（零改动）

- `MessageEnvelope.reply_to` 保持不变。
- 在 `backend/doc/doc.md` §消息模型 增加一条注释：
  > `reply_to` 字段语义由 `type` 决定：`type=message` 表示引用回复目标；`type∈{ack,result,error}` 表示 receipt 链接的原消息。
- 这里的"零改动"指签名 envelope / wire schema 不新增字段；`/hub/inbox` 响应 DTO 与 SDK TypeScript 类型会新增可选 preview 字段，属于读取侧扩展。

### 3.3 数据模型与迁移

**a. `MessageRecord` 新增列**（`backend/hub/models.py:481`）

```python
reply_to_msg_id: Mapped[str | None] = mapped_column(
    String(64), nullable=True, index=False  # 单列索引意义不大，走复合索引
)
```

**b. 复合索引**（`__table_args__`）

```python
Index("ix_message_records_room_reply_to", "room_id", "reply_to_msg_id"),
```

用途：`SELECT * FROM message_records WHERE room_id=? AND reply_to_msg_id=?`（反查"这条消息的所有回复"）。

**c. SQL 迁移**：`backend/migrations/NNN_add_reply_to_msg_id.sql`

```sql
ALTER TABLE message_records
    ADD COLUMN reply_to_msg_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS ix_message_records_room_reply_to
    ON message_records (room_id, reply_to_msg_id)
    WHERE reply_to_msg_id IS NOT NULL;
```

- partial index（`WHERE reply_to_msg_id IS NOT NULL`）减少索引体积，因为绝大多数消息没有 reply。
- 不回填历史数据：旧消息没有被引用的需求，envelope_json 里存在的 reply_to 历史值若有需要后续 backfill。

**d. 不存储引用快照**：被引用消息的 `text` / `attachments` 不冗余进新表，前端/agent 通过 join 原 `MessageRecord` 实时获取。

### 3.4 后端 API 改造

#### 3.4.1 `/hub/send`（`hub/routers/hub.py`）

校验不能放在 `send_message()` 顶层统一做，因为 direct message 的 `room_id` 是 `_send_direct_message()` 内部通过 `_ensure_dm_room()` 才得到的。实现上应把 `reply_to` 解析为 helper，并在 direct / room 两个分支各自拿到有效 `room_id` 后校验。

建议 helper：

```python
def _message_reply_to(envelope: MessageEnvelope) -> str | None:
    return envelope.reply_to if envelope.type == MessageType.message else None


async def _load_reply_target(
    db: AsyncSession,
    *,
    room_id: str,
    reply_to_msg_id: str,
    viewer_id: str,
) -> MessageRecord:
    # 1. 先按 msg_id 查代表记录；若存在但 room_id 不同，返回 reply_target_cross_room。
    # 2. 目标必须存在于同 room。
    # 3. 可见性按“room member 可读该 room 历史”处理，和 dashboard room history 对齐。
    # 4. fan-out 可能有多条同 msg_id 记录，取最早代表记录即可。
    any_target_stmt = (
        select(MessageRecord)
        .where(
            MessageRecord.msg_id == reply_to_msg_id,
        )
        .order_by(MessageRecord.id.asc())
        .limit(1)
    )
    target = await db.scalar(any_target_stmt)
    if target is None:
        raise I18nHTTPException(status_code=400, message_key="reply_target_not_found")
    if target.room_id != room_id:
        raise I18nHTTPException(status_code=400, message_key="reply_target_cross_room")
    return target
```

落点：

- `_send_room_message()`：先验证 sender 是 RoomMember 且可发送，再用同一个 `room_id` 校验引用目标。
- `_send_direct_message()`：先完成 receiver admission 与 `_ensure_dm_room()`，得到 DM `room_id` 后校验引用目标。
- dashboard/human 路径：先验证当前 Human/active Agent 对 room 有成员可读权限；如果 sender 不是目标 room 的可见参与者，返回 `reply_target_forbidden`。
- `contact_request`、`result`、`error` 不写新列；receipt 语义仍走 `/hub/receipt`。
- 创建每条 `MessageRecord` 时写入 `reply_to_msg_id=_message_reply_to(envelope)`。

补充错误码（`hub/i18n.py`）：

| code | EN | ZH |
|---|---|---|
| `reply_target_requires_room` | Reply target requires a room context | 引用消息必须在房间内 |
| `reply_target_not_found` | Reply target message not found | 引用的消息不存在或不可见 |
| `reply_target_cross_room` | Cannot reply across rooms | 不能跨房间引用消息 |
| `reply_target_forbidden` | Reply target is not visible to the sender | 无权引用该消息 |

#### 3.4.2 `/hub/history`（`hub/routers/hub.py`）

响应消息对象新增 `reply_to` 结构：

```jsonc
{
  "msg_id": "h_xxx",
  "from": "ag_alice",
  "text": "I agree with that",
  "reply_to": {
    "msg_id": "h_yyy",
    "sender_id": "ag_bob",
    "sender_display_name": "Bob",
    "text_preview": "We should ship the feature next sprint...",
    "topic_id": "tp_abc",  // 如果引用消息属于不同 topic
    "deleted": false
  }
}
```

实现：在序列化阶段批量 join：

```python
reply_ids = {m.reply_to_msg_id for m in messages if m.reply_to_msg_id}
if reply_ids:
    # MessageRecord 是 fan-out 表，同一个 msg_id 可能有多条 receiver 记录。
    # preview 必须按 msg_id 去重，取最早一条代表记录。
    target_min_id = (
        select(func.min(MessageRecord.id).label("min_id"))
        .where(
            MessageRecord.msg_id.in_(reply_ids),
            MessageRecord.room_id.in_(room_ids_from_current_page),
        )
        .group_by(MessageRecord.msg_id)
        .subquery()
    )
    targets = await db.execute(
        select(MessageRecord).where(MessageRecord.id.in_(select(target_min_id.c.min_id)))
    )
    target_map = {t.msg_id: t for t in targets.scalars()}
    # 对每条消息拼装 reply_to dict, preview 截 ≤120 字。
    # 如果 reply_to_msg_id 存在但 target_map 缺失，则返回 deleted=true。
```

新增 query：`?replies_to=<msg_id>` —— 反查回复列表（F6，可作为二期可选）。
若实现 F6，同样必须按回复消息的 `msg_id` 去重，否则 room fan-out 会把同一条回复重复返回给每个 receiver。

#### 3.4.3 `/hub/inbox` + realtime event

当前 `build_message_realtime_event()` 只透传 `sender_id`、`sender_name`、`topic_id`、`preview`、`mentioned` 等字段；receipt realtime 事件才有 `reply_to`。message realtime 需要追加 `reply_to` 与 `reply_preview`：

```python
ext={
    "sender_id": sender_id,
    "topic_id": topic_id,
    "reply_to": reply_to,
    "reply_preview": reply_preview,  # 同 history 的结构体
},
```

实现时在 fan-out 阶段就预取 preview，避免每个 receiver 推送时重复查询。`/hub/inbox` 的 `InboxMessage` 也应新增同样的 `reply_to` 结构体字段，daemon 才能在 prompt composer 中使用；`envelope.reply_to` 继续保留原始 msg_id。

注意：`/hub/ws` 当前只发送 `{"type": "inbox_update"}`，不承载 message payload；真正带 `ext` 的是 `_publish_agent_realtime_event()` 发布的 agent/human realtime 事件。不要把 preview 塞进 `/hub/ws` wake 帧。

#### 3.4.4 Receipt 路径保持不变

`receipt_must_have_reply_to` 校验保留（`hub.py:1500-1501`）。落 receipt 时**不写**新列 `reply_to_msg_id`（用 `type` 区分），保持新列只承载用户引用回复语义，查询更干净。

#### 3.4.5 Dashboard send 路径

当前 dashboard 主路径不在 `frontend/src/app/api/...`，而是前端 `frontend/src/lib/api.ts` 直接调用后端 app router：

- room 人类发言：`backend/app/routers/dashboard.py::human_room_send`
- owner-chat 发言：`backend/app/routers/dashboard.py::send_chat_message`
- legacy/Hub 内部 owner-chat router：`backend/hub/routers/dashboard_chat.py::send_chat_message`

这些路径当前都会构造 synthetic envelope，并把 `"reply_to": None` 写死。需要：

1. `HumanRoomSendBody` / `ChatSendBody` 增加 `reply_to: str | None`（可选兼容 `replyTo` alias）。
2. 复用 3.4.1 的引用目标校验：同 room、sender 可见；owner-chat 先确保 `rm_oc_*` room 已存在再校验。
3. synthetic envelope 写入 `"reply_to": body.reply_to`。
4. `MessageRecord.reply_to_msg_id` 写入同一个值。
5. realtime event 与 room messages API 返回 `reply_preview` / `reply_to` 结构。

#### 3.4.6 Daemon prompt 渲染

当前 agent runtime 的 BotCord prompt 不是由 `backend/hub/schemas.py::to_text()` 直接生成，而是：

1. Hub `/hub/inbox` 返回 `InboxMessage.text` + structured fields；
2. daemon `packages/daemon/src/gateway/channels/botcord.ts::normalizeInbox()` 转成 `GatewayInboundMessage`；
3. daemon `packages/daemon/src/turn-text.ts::composeBotCordUserTurn()` 拼装最终 user turn。

因此引用上下文应在 daemon 的 turn composer 中渲染：

```python
# 伪代码，真实实现为 TypeScript
if message.replyTo and message.replyPreview:
    quote_line = f'[Quote {sender}: "{preview}"]'
    user_turn = f"{quote_line}\n{user_turn}"
```

需要同步扩展：

- `packages/protocol-core/src/types.ts::InboxMessage`：增加 `reply_to?: ReplyPreview | null` 或 `reply_preview?: ReplyPreview | null`；
- `packages/daemon/src/gateway/channels/botcord.ts`：从 raw inbox 读取 preview，放入 `GatewayInboundMessage.raw` 或新增 typed field；
- `packages/daemon/src/turn-text.ts`：普通单条消息和 batched turn 都渲染 1 层引用，不递归展开嵌套引用。

`backend/hub/schemas.py::to_text()` 可作为兼容路径补充同样能力，但它不是本需求 G4 的主落点。

### 3.5 Frontend 改造

#### 3.5.1 协议常量

`frontend/src/data/protocol-primitives.ts`：补 `reply_to` 双语义说明。

#### 3.5.2 Chat store

当前 frontend 类型与状态集中在：

- `frontend/src/lib/types.ts::DashboardMessage`
- `frontend/src/store/useDashboardChatStore.ts`
- `frontend/src/store/useOwnerChatStore.ts`
- room 发送入口 `frontend/src/components/dashboard/RoomHumanComposer.tsx`
- owner-chat 发送入口 `frontend/src/components/dashboard/UserChatPane.tsx`

```ts
interface ReplyPreview {
  msg_id: string;
  sender_id: string;
  sender_display_name: string;
  text_preview: string;
  topic_id?: string | null;
  deleted: boolean;
}

interface DashboardMessage {
  // existing fields...
  reply_to?: ReplyPreview | null;
}

interface ChatStore {
  replyingTo: DashboardMessage | null;
  setReplyingTo: (m: DashboardMessage | null) => void;
  sendMessage: (text: string, opts?: { reply_to?: string }) => Promise<void>;
}
```

#### 3.5.3 UI 组件

| 组件 | 改动 |
|---|---|
| `frontend/src/components/dashboard/MessageBubble.tsx` | 顶部渲染 `<ReplyQuoteBlock />`（灰条 + 发送者 + preview），click → 触发滚动定位 |
| `frontend/src/components/dashboard/MessageBubble.tsx` | hover/更多菜单显示 Reply 入口，click → `setReplyingTo(message)` |
| `RoomHumanComposer.tsx` / `UserChatPane.tsx` | 输入框上方渲染"正在回复 @xxx: ..."的可关闭横条 |
| `RoomHumanComposer.tsx` / `UserChatPane.tsx` | submit 时把 `replyingTo.msg_id` 作为 `reply_to` 传给 send API |
| `frontend/src/components/dashboard/MessageList.tsx` | 给每条消息添加稳定 `data-msg-id`，接收 `scrollToMessage(msgId)` 事件，scrollIntoView + 高亮 1.5s |

#### 3.5.4 滚动定位降级

```ts
async function scrollToMessage(msgId: string) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    highlight(el, 1500);
    return;
  }
  // 不在 DOM：拉一段上下文
  await fetchHistoryAround(msgId, 20);
  // 再次尝试
  setTimeout(() => scrollToMessage(msgId), 100);
}
```

`fetchHistoryAround` 需要后端 `/hub/history?around=<msg_id>&limit=20`，**当前不存在**，本期可暂不实现降级，先做"不在 DOM 时弹 toast 提示'消息不在当前视图'"，作为 P1 跟进。

### 3.6 CLI 改造

当前 `cli/src/commands/send.ts` 已经支持：

```ts
--reply-to <id>     Reply to a specific message ID
```

且 `packages/protocol-core/src/client.ts::sendMessage()` / `buildSignedEnvelope()` 已经能把 `replyTo` 塞进 `envelope.reply_to` 并参与签名。CLI 本期主要补测试/文档即可，无需作为新功能实现项。

### 3.7 Dashboard API

当前没有 `frontend/src/app/api/dashboard/.../send/route.ts` 这一层 BFF；frontend 通过 `frontend/src/lib/api.ts` 访问后端 `/api/dashboard/rooms/{room_id}/send`。

需要改造：

- `frontend/src/lib/api.ts::sendRoomHumanMessage()` 增加 `reply_to?: string` 入参并写入请求体；
- `backend/app/routers/dashboard.py::HumanRoomSendBody` 增加 `reply_to`；
- `backend/app/routers/dashboard.py::human_room_send()` 写入 synthetic envelope 与 `MessageRecord.reply_to_msg_id`；
- owner-chat 路径 `sendUserChatMessage()` / `/api/dashboard/chat/send` 同步处理，否则私聊入口无法引用回复。

---

## 4. 兼容性与灰度

### 4.1 向后兼容矩阵

| 客户端版本 | 发送 | 接收 |
|---|---|---|
| 老 CLI / daemon → 新 Hub | 不带 reply_to，正常 | 新字段被忽略，正常 |
| 新 CLI → 老 Hub | 老 Hub 不识别但 envelope 合法 → 落库到 envelope_json，行为退化为"无引用" |
| 新 Hub → 老前端 | 老前端不渲染 `reply_to`，无视觉异常 |
| 新 Hub → 新前端 | 完整渲染引用块 |

### 4.2 灰度顺序

1. **Phase 1（后端）**：迁移 + 落库 + `/hub/send` 与 `/api/dashboard/.../send` 校验 + history/inbox 返回字段 + receipt 路径不动。**对老前端零影响**，可独立上线。
2. **Phase 2（前端）**：渲染引用块 + Reply 入口 + 引用横条。
3. **Phase 3（Daemon prompt + CLI 文档/测试）**：daemon `composeBotCordUserTurn()` 引用行注入；CLI 已有 `--reply-to`，补覆盖。
4. **Phase 4（可选）**：F6 反查 API、history `around` 降级、引用统计指标。

### 4.3 回滚预案

- Phase 1 回滚：drop 新列即可，envelope_json 中的 reply_to 兼容老逻辑（仍仅在 receipt 路径生效）。
- Phase 2 回滚：前端发布回退，不影响后端数据。

---

## 5. 测试方案

### 5.1 单元 / 集成测试（backend）

| 文件 | 用例 |
|---|---|
| `tests/test_room.py` / `tests/test_m3_hub.py` | 同 room 引用 → 200；direct DM 引用 → 200；跨 room → 400 `reply_target_cross_room`；目标不存在 → 400 `reply_target_not_found`；引用自己看不见的 → 400/403；引用已删除/缺失 preview → 200 + `deleted: true` |
| realtime/websocket 相关测试 | agent realtime event ext 包含 `reply_to` 与 `reply_preview`；`/hub/ws` 仍只发 `inbox_update` wake 帧 |
| `tests/test_app/test_app_dashboard.py` | `/api/dashboard/rooms/{room_id}/send` 与 `/api/dashboard/chat/send` 发送带 `reply_to` 时正确透传到 envelope 与 `reply_to_msg_id` |
| `tests/test_m1.py` | `MessageEnvelope` 带 `reply_to` + `type=message` 时签名验签通过 |
| `tests/test_topics.py` | 跨 topic 引用允许，preview 包含 `topic_id` |

### 5.2 E2E（`e2e/`）

原计划新增 `e2e/scenarios/quote-reply.yaml`，覆盖 A 发送 → B 引用 → A 拉 inbox/history 校验。

**实施时的范围调整**：YAML runner 当前只暴露 `extract_room_id` / `extract_approval_id` 等定向 extractor，没有通用 `msg_id` 提取或 `reply_preview` 断言；加上需要 ~50 行 runner 扩展。

权衡后**本期延后**该场景：
- 后端 `tests/test_quote_reply.py` 已用 FastAPI ASGI transport 走完整 HTTP 栈，覆盖 send/history/inbox 全链路（8 用例）；
- daemon `__tests__/turn-text.test.ts` 覆盖了 prompt 注入 + tombstone（5 用例）；
- frontend vitest 套件 120 用例无回归。

YAML e2e 留作后续 P1 — 需要先扩 runner DSL（generic `extract_field` + `assert_response_path`）。

### 5.3 前端

- Chat store 单测：`setReplyingTo` + `sendMessage` 携带 `reply_to`。
- 组件渲染快照：`ReplyQuoteBlock` 三种状态（正常 / deleted / 跨 topic）。

---

## 6. 工作量与里程碑

| 模块 | 估计 |
|---|---|
| 后端落库 + 校验 + history/inbox 字段 + i18n | ~200 行 + 1 个 SQL 迁移 + ~150 行测试 |
| Daemon prompt 注入（`composeBotCordUserTurn()`） | ~60 行 |
| Dashboard API 透传 | ~40 行 |
| 前端 chat store + UI 组件 | ~400-600 行 |
| 前端测试 | ~100 行 |
| CLI 参数 | ~20 行 |
| E2E 场景 | ~80 行 |
| 文档（doc.md / changelog） | ~50 行 |

**总工作量**：1 名工程师 2-3 个工作日闭环到可灰度。

**里程碑**：

| 里程碑 | 内容 |
|---|---|
| M1 (Day 1) | 后端 PR：迁移 + 落库 + send 校验 + history/inbox 输出 + 测试 |
| M2 (Day 2) | Daemon `composeBotCordUserTurn` + Dashboard API + CLI 覆盖 + E2E |
| M3 (Day 3) | 前端 PR：UI 组件 + chat store + 跳转高亮 |

---

## 7. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| `reply_to` 字段双语义引起 API 调用方混淆 | 中 | `doc.md` 显式说明 + history 响应里只在 `type=message` 时返回 `reply_to` 结构体，receipt 不返回 |
| 索引膨胀（partial index 但 message_records 量大） | 低 | partial index `WHERE reply_to_msg_id IS NOT NULL` 显著减小；监控 index size |
| 跳转定位卡顿（原文不在 DOM 需拉取） | 低 | 本期降级为 toast 提示；P1 跟进 `?around=` 接口 |
| 被引用消息长文本截断丢失关键信息 | 低 | preview 120 字 + 点击跳原文，符合主流 IM 习惯 |
| Agent prompt 注入引用上下文使 token 增加 | 低 | preview 已截断；可通过 daemon 配置开关关掉 |
| 嵌套引用（B 引用了 A 的引用消息）渲染递归 | 中 | UI 只渲染 1 层，envelope 里仍保留完整 reply_to |
| Race condition：引用目标在校验通过后被删除 | 低 | 接受最终一致——前端按 `deleted: true` 渲染 |

---

## 8. 未决事项

- [ ] 反查 API（F6 `?replies_to=`）是否本期实现？建议 **延后**，等用户反馈再做。
- [ ] `/hub/history?around=<msg_id>` 跳转降级接口是否本期实现？建议 **延后**。
- [ ] Dashboard 是否需要"右键菜单 → 复制消息链接"以便分享引用？建议 **延后**。
- [ ] AI Agent 是否能"主动引用"？理论上可以（daemon 拼装 envelope 时填 reply_to），但需要 agent prompt 教学。建议本期 **不主动推进**，看 agent 是否自发使用。

---

## 9. 附录

### 9.1 涉及文件清单

```
backend/
├── app/
│   └── routers/
│       └── dashboard.py           # /api/dashboard/rooms/{room_id}/send、/api/dashboard/chat/send 透传 reply_to
├── hub/
│   ├── models.py                 # MessageRecord 新增 reply_to_msg_id 列 + 索引
│   ├── schemas.py                # InboxMessage / HistoryMessage 增加 reply_to preview 字段；to_text 可做兼容补充
│   ├── i18n.py                   # 新增错误码
│   └── routers/
│       ├── hub.py                # /hub/send 校验 + 落库；/hub/history、/hub/inbox 输出
│       └── dashboard_chat.py     # legacy owner-chat 路径 reply_to 透传
├── migrations/
│   └── NNN_add_reply_to_msg_id.sql
├── tests/                        # 新增/扩展用例
└── doc/
    ├── doc.md                    # §消息模型 reply_to 双语义说明
    └── quote-reply-prd.md        # 本文件

packages/protocol-core/
└── src/types.ts                   # InboxMessage 增加 reply preview 类型（wire 兼容，非签名协议变更）

packages/daemon/
└── src/
    ├── gateway/channels/botcord.ts # normalizeInbox 保留 reply preview
    └── turn-text.ts                # composeBotCordUserTurn 渲染引用上下文

cli/
└── src/commands/send.ts           # 已有 --reply-to；补测试/文档

frontend/
├── src/
│   ├── lib/
│   │   ├── api.ts                    # sendRoomHumanMessage 透传 reply_to
│   │   └── types.ts                  # DashboardMessage.reply_to 类型
│   ├── store/
│   │   ├── useDashboardChatStore.ts  # replyingTo + send 入参
│   │   └── useOwnerChatStore.ts      # owner-chat replyingTo
│   └── components/dashboard/
│       ├── MessageBubble.tsx         # 引用块 + Reply 入口
│       ├── MessageList.tsx           # data-msg-id + 滚动定位 + 高亮
│       ├── RoomHumanComposer.tsx     # 引用横条 + 透传 reply_to
│       ├── UserChatPane.tsx          # owner-chat 引用横条 + 透传 reply_to
│       └── ReplyQuoteBlock.tsx       # 新增

e2e/
└── scenarios/quote-reply.ts          # 新增
```

### 9.2 API 变更速查

| API | 变更 |
|---|---|
| `POST /hub/send` | 新增 `reply_to` 语义校验；失败返回 400 `reply_target_*` 错误码 |
| `GET /hub/history` | 响应每条消息新增 `reply_to: { msg_id, sender_id, sender_display_name, text_preview, topic_id, deleted } \| null` |
| `GET /hub/inbox` | 同上 |
| agent/human realtime event | event ext 新增 `reply_preview`；`/hub/ws` 仍只发 `inbox_update` |
| `POST /api/dashboard/rooms/{room_id}/send` | 请求体新增可选 `reply_to: string`（可兼容 `replyTo` alias） |
| `POST /api/dashboard/chat/send` | 请求体新增可选 `reply_to: string`（owner-chat） |

### 9.3 不向下兼容点

无。所有变更对老客户端透明。
