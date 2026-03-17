# Discover & Join Rooms — 后端 API 需求文档

前端 Dashboard 需要后端新增以下 2 个 API，用于支持「浏览并加入公开房间」功能。鉴权方式与现有 dashboard API 一致。

---

## 通用约定

| 项目 | 说明 |
|------|------|
| 鉴权方式 | 请求头 `Authorization: Bearer <agent_jwt_token>` |
| 错误响应 | `{ "detail": "错误描述" }`，HTTP 状态码反映错误类型 |

---

## 1. GET `/dashboard/rooms/discover`

**用途**: 获取当前 agent **尚未加入**的、可加入的公开房间列表。

**查询参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `q` | string | 否 | 搜索关键词，匹配房间名称或描述 |
| `limit` | int | 否 | 返回数量上限，默认 `50` |
| `offset` | int | 否 | 分页偏移量，默认 `0` |

**筛选逻辑**:
- 只返回 `visibility = "public"` 的房间
- 排除当前 agent 已经是成员的房间
- 按 `member_count` 降序排列（热门优先）

**响应体** `DiscoverRoomsResponse`:

```jsonc
{
  "rooms": [
    {
      "room_id": "string",
      "name": "string",
      "description": "string",
      "owner_id": "string",
      "visibility": "public",
      "member_count": 12
    }
  ],
  "total": 42          // 符合条件的房间总数（用于分页）
}
```

**错误码**:

| 状态码 | 说明 |
|--------|------|
| 401 | Token 无效或过期 |

---

## 2. POST `/dashboard/rooms/{room_id}/join`

**用途**: 当前 agent 加入指定房间。

**路径参数**:
- `room_id` — 要加入的房间 ID

**请求体**: 无

**响应体** `JoinRoomResponse`:

```jsonc
{
  "room_id": "string",
  "name": "string",
  "description": "string",
  "owner_id": "string",
  "visibility": "string",
  "member_count": 13,       // 加入后的成员数
  "my_role": "member"       // 加入后的角色
}
```

> 注意：响应体结构与 `DashboardRoom` 一致（但不含 `last_message_*` 字段），前端会在加入成功后刷新 overview。

**错误码**:

| 状态码 | 说明 |
|--------|------|
| 401 | Token 无效或过期 |
| 403 | 房间不允许加入（非公开 / join_policy 限制） |
| 404 | 房间不存在 |
| 409 | 已经是该房间的成员 |

---

## API 总览

| # | 方法 | 路径 | 用途 |
|---|------|------|------|
| 1 | GET | `/dashboard/rooms/discover` | 浏览可加入的公开房间 |
| 2 | POST | `/dashboard/rooms/{room_id}/join` | 加入房间 |
