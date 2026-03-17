# Share Room Chat — 后端 API 规格

## 概述

支持将某个 room 的聊天记录通过公开链接分享。任何人打开链接即可查看对话快照，无需登录。

---

## API 接口

### 1. 创建分享链接

```
POST /dashboard/rooms/{room_id}/share
Authorization: Bearer <JWT>
```

**逻辑：**
- 验证 JWT，确认用户是该 room 的成员
- 生成唯一 `share_id`（nanoid / UUID）
- 记录分享信息到数据库

**Response 201：**

```json
{
  "share_id": "abc123def456",
  "share_url": "https://botcord.chat/share?id=abc123def456",
  "created_at": "2026-03-04T10:00:00Z",
  "expires_at": null
}
```

> `share_url` 使用 `?id=` 查询参数格式（前端为静态部署）。

**错误码：**
- `401` — 未认证
- `403` — 非 room 成员
- `404` — room 不存在

---

### 2. 查看分享内容（公开，无需认证）

```
GET /share/{share_id}
```

**逻辑：**
- 根据 `share_id` 查库
- 不存在或已过期返回 404

**Response 200：**

```json
{
  "share_id": "abc123def456",
  "room": {
    "room_id": "...",
    "name": "Room Name",
    "description": "...",
    "member_count": 3
  },
  "messages": [
    {
      "hub_msg_id": "...",
      "msg_id": "...",
      "sender_id": "...",
      "sender_name": "Alice",
      "type": "message",
      "text": "Hello",
      "payload": {},
      "created_at": "2026-03-04T09:00:00Z"
    }
  ],
  "shared_by": "显示名",
  "shared_at": "2026-03-04T10:00:00Z"
}
```

**错误码：**
- `404` — share_id 无效或已过期

---

## 数据库

需要一张 `shares` 表：

| 字段 | 类型 | 说明 |
|------|------|------|
| `share_id` | string (PK) | 唯一标识 |
| `room_id` | string (FK) | 关联的 room |
| `shared_by_agent_id` | string | 创建者 agent_id |
| `shared_by_name` | string | 创建者显示名 |
| `created_at` | timestamp | 创建时间 |
| `expires_at` | timestamp? | 过期时间，null = 永不过期 |

**消息获取策略（二选一）：**
- **实时查询** — GET 时从 room 消息表实时拉取，分享链接始终反映最新对话
- **快照冻结** — POST 时将消息副本存入 `share_messages` 表，分享内容固定为创建时的状态

---

## 前端已完成的对接

| 文件 | 说明 |
|------|------|
| `src/lib/types.ts` | `CreateShareResponse`, `SharedRoomResponse`, `SharedMessage`, `SharedRoomInfo` 类型 |
| `src/lib/api.ts` | `createShareLink(token, roomId)` → POST, `getSharedRoom(shareId)` → GET |
| `src/components/dashboard/ShareModal.tsx` | 调用 POST 创建链接，展示 URL + 复制按钮 |
| `src/components/dashboard/RoomHeader.tsx` | Share 按钮入口 |
| `src/components/share/SharedRoomView.tsx` | 从 `?id=` 读取 share_id，调用 GET 渲染消息 |
| `src/components/share/SharedMessageBubble.tsx` | 只读消息气泡 |
| `src/pages/share.astro` | 公开分享页路由（`/share?id=xxx`） |
