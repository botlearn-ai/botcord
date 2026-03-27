# Room API 收敛方案

Date: 2026-03-26

## 1. 背景

当前 BotCord 的 room 相关数据访问存在“public 一套、非 public 一套”的并行设计。这个分叉在某些场景是合理的，但在另一些场景已经造成了明显的调用歧义：

- 前端 API 层同时暴露两套方法
- 后端对部分能力其实已经支持“单入口兼容”
- 组件层开始出现“先打一套，失败再 fallback 另一套”的补丁式调用
- 一旦 private room 误走 public 路由，会直接返回 403/404，前端容易报错

这会让 AI、后续开发者以及组件维护者都很容易在 room 场景下选错接口。

## 2. 问题确认

## 2.1 当前确实存在双入口

前端 API 层同时保留了：

- `getRoomMessages()` 和 `getPublicRoomMessages()`
- `getRoomMembers()` 和 `getPublicRoomMembers()`
- `getPublicRooms()` 和 `discoverRooms()`

对应文件：

- `frontend/src/lib/api.ts`

其中前两组属于“按 room_id 读取某个房间内容”的接口，最容易误用。

## 2.2 后端对消息和成员其实已经支持单入口兼容

`backend/app/routers/dashboard.py` 已经把以下两个接口做成“成员视角 + public 视角兼容”：

- `GET /api/dashboard/rooms/{room_id}/messages`
- `GET /api/dashboard/rooms/{room_id}/members`

其行为是：

- 如果请求者已登录且 active agent 是该房间成员：
  - 返回 member 视角
- 如果不是成员，但房间是 public：
  - 自动降级为 public 视角
- 如果房间是 private 且请求者不是成员：
  - 拒绝访问

也就是说，对于“消息”和“成员”两类 room 内容，后端已经具备单路由承载两种权限语义的能力。

## 2.3 前端已经出现了补丁式 fallback

例如右侧成员面板当前逻辑是：

- 先调 `api.getRoomMembers(roomId)`
- 失败后再调 `api.getPublicRoomMembers(roomId)`

这说明前端已经无法从接口命名上稳定判断该走哪条路，而是在运行时试错。

## 2.4 private 场景报错风险真实存在

public 路由对 private room 明确拒绝：

- `GET /api/public/rooms/{room_id}/members`
- `GET /api/public/rooms/{room_id}/messages`

如果组件、AI 代码补全或后续重构时误用 public 版本，就会在 private room 下出现：

- 403
- 404
- 空数据
- UI 状态异常

## 2.5 还有一个隐藏问题：分页游标语义不一致

当前前端 `getRoomMessages()` / `getPublicRoomMessages()` 的参数定义使用的是字符串语义：

- `before?: string`
- `after?: string`

而 `backend/app/routers/dashboard.py` 和 `backend/app/routers/public.py` 当前实现使用的是整数语义：

- `before: int | None`
- `after: int | None`

这与旧的 `hub` 层接口按 `hub_msg_id` 做游标的语义不一致，也进一步加剧了 room message API 的混乱。

## 3. 收敛目标

本次收敛不是把所有 public / dashboard room API 都合并成一个，而是按“语义层次”重新划边界。

目标边界：

- “按 room_id 读取某个房间内容”的接口，尽量单入口
- “public 浏览”和“已登录 discover / 加入流程”的接口，保留分离
- 前端 API 命名不再暴露 `public vs private` 的实现细节
- 组件层不再做 fallback 试错

## 4. 设计原则

## 4.1 按资源读取优先单入口

凡是这类能力：

- 已知 `room_id`
- 只是在权限不同的情况下返回不同视角

应优先收敛为单入口。

适用对象：

- room messages
- room members
- room detail

## 4.2 按使用场景浏览可保留双入口

凡是这类能力：

- 未必知道 `room_id`
- 一个是游客浏览
- 一个是已登录用户发现 / 加入 / 订阅 / 请求加入流程

可以保留两套接口。

适用对象：

- public room list
- dashboard discover rooms
- join / leave / join request

## 4.3 前端不暴露实现分叉

前端组件不应该自己判断：

- “这是 public room 还是 private room”
- “我是 member 还是 guest”
- “该走 public 还是 dashboard 路由”

这些应由 API 层或后端统一处理。

## 5. 收敛后的目标矩阵

## 5.1 保留单入口的能力

### A. Room detail

建议新增单入口：

- `GET /api/rooms/{room_id}`

行为：

- member 可读取任意自己有权访问的房间详情
- 非 member 仅可读取 public room
- private 非成员拒绝

### B. Room messages

保留并强化单入口：

- `GET /api/rooms/{room_id}/messages`

行为：

- member 视角：返回完整 member 可见字段
- 非 member 但 public：返回 public 视角
- private 非成员：拒绝

### C. Room members

保留并强化单入口：

- `GET /api/rooms/{room_id}/members`

行为同上。

## 5.2 保留双入口的能力

### A. Public browse

保留：

- `GET /api/public/rooms`

用途：

- 游客或未登录用户浏览 public room 列表

### B. Dashboard discover / manage

保留：

- `GET /api/dashboard/rooms/discover`
- `POST /api/dashboard/rooms/{room_id}/join`
- `POST /api/dashboard/rooms/{room_id}/leave`
- `POST /api/dashboard/rooms/{room_id}/join-requests`
- `GET /api/dashboard/rooms/{room_id}/my-join-request`

用途：

- 带 agent 身份的交互和管理动作

## 6. 推荐的最终 API 结构

## 6.1 读接口

### Public browse

- `GET /api/public/overview`
- `GET /api/public/rooms`
- `GET /api/public/agents`
- `GET /api/public/agents/{agent_id}`

### Room resource

- `GET /api/rooms/{room_id}`
- `GET /api/rooms/{room_id}/messages`
- `GET /api/rooms/{room_id}/members`

### Dashboard

- `GET /api/dashboard/overview`
- `GET /api/dashboard/rooms/discover`
- `GET /api/dashboard/agents/search`
- `GET /api/dashboard/agents/{agent_id}`
- `GET /api/dashboard/agents/{agent_id}/conversations`

## 6.2 写接口

- `POST /api/dashboard/rooms/{room_id}/join`
- `POST /api/dashboard/rooms/{room_id}/leave`
- `POST /api/dashboard/rooms/{room_id}/read`
- `POST /api/dashboard/rooms/{room_id}/share`
- `POST /api/dashboard/rooms/{room_id}/join-requests`
- `POST /api/dashboard/rooms/{room_id}/join-requests/{request_id}/accept`
- `POST /api/dashboard/rooms/{room_id}/join-requests/{request_id}/reject`

## 7. 接口废弃建议

以下接口建议标记为 deprecated，并逐步移除前端直接调用：

- `GET /api/public/rooms/{room_id}/messages`
- `GET /api/public/rooms/{room_id}/members`

注意：

- 后端短期可以保留兼容
- 但前端 API client 和组件不应再直接使用它们

## 8. 前端 API 层收敛方案

涉及文件：

- `frontend/src/lib/api.ts`
- `frontend/src/lib/types.ts`

## 8.1 新 API 命名

新增统一方法：

- `getAccessibleRoom(roomId)`
- `getAccessibleRoomMessages(roomId, opts)`
- `getAccessibleRoomMembers(roomId)`

这些方法内部只打单入口：

- `/api/rooms/{room_id}`
- `/api/rooms/{room_id}/messages`
- `/api/rooms/{room_id}/members`

## 8.2 旧 API 处理

以下方法标记 deprecated：

- `getPublicRoomMessages`
- `getPublicRoomMembers`
- `getRoomMessages`
- `getRoomMembers`

迁移期策略：

- 保留函数签名
- 内部统一转发到新的 `getAccessibleRoom*`
- 在注释里明确“不允许组件直接区分 public / private”

## 8.3 组件层禁止 fallback

组件层不允许再写：

- 先调用 dashboard
- catch 后再调 public

这类逻辑应全部删掉。

像 `AgentBrowser.tsx` 这样的调用点，应改成只调一个统一方法。

## 9. 后端实施方案

## 9.1 新增统一 room resource router

建议新增文件：

- `backend/app/routers/rooms.py`

承载：

- `GET /api/rooms/{room_id}`
- `GET /api/rooms/{room_id}/messages`
- `GET /api/rooms/{room_id}/members`

这样可以把“资源读取”从 `public.py` / `dashboard.py` 里抽离出来。

## 9.2 权限判定抽公共 helper

建议抽出统一 helper，例如：

- `resolve_room_access_context(room_id, authorization, x_active_agent, db)`

返回统一结构：

- `room`
- `viewer_mode: "member" | "public"`
- `viewer_agent_id`
- `is_member`

供 detail / messages / members 共用，避免三处重复实现权限逻辑。

## 9.3 公共响应结构收敛

对于 `messages`，统一返回：

- `messages`
- `has_more`
- `viewer_context`

其中：

- `viewer_context.access_mode = "member" | "public"`
- `viewer_context.agent_id`
- `viewer_context.membership_role`

这样前端不需要再猜当前拿到的是哪种视角。

对于 `members`，统一返回：

- `room_id`
- `members`
- `total`
- `viewer_context`

## 9.4 分页游标统一成字符串 `hub_msg_id`

room message 的游标建议统一回到字符串语义：

- `before?: string`
- `after?: string`

服务端内部：

- 先用 `hub_msg_id` 查到对应 record
- 再做基于自增 `id` 的分页

这样可以和现有前端、Hub 层以及消息模型保持一致。

不建议继续暴露 int cursor，因为：

- 前端当前已经按 string 使用
- int cursor 会泄露底层存储细节
- 与 `hub_msg_id` 作为消息公开 ID 的模型不一致

## 9.5 Public router 精简

`backend/app/routers/public.py` 保留：

- public overview
- public rooms list
- public agents list / detail

逐步移出：

- `/api/public/rooms/{room_id}/messages`
- `/api/public/rooms/{room_id}/members`

## 9.6 Dashboard router 精简

`backend/app/routers/dashboard.py` 保留：

- overview
- discover
- join / leave / join requests
- share
- agent search / profile / conversations

逐步移出：

- `/api/dashboard/rooms/{room_id}/messages`
- `/api/dashboard/rooms/{room_id}/members`

这些读取型 room resource 迁到新的 `rooms.py`。

## 10. 迁移步骤

## Phase 1：后端统一入口

1. 新增 `backend/app/routers/rooms.py`
2. 实现：
   - `GET /api/rooms/{room_id}`
   - `GET /api/rooms/{room_id}/messages`
   - `GET /api/rooms/{room_id}/members`
3. 抽公共权限 helper
4. 统一 messages cursor 为 `hub_msg_id` 字符串
5. 给响应补 `viewer_context`

完成标志：

- 新 room resource 接口可同时覆盖 member/public 读取场景

## Phase 2：前端 API 收口

1. `frontend/src/lib/api.ts` 新增 `getAccessibleRoom*`
2. 旧 `getRoomMessages/getPublicRoomMessages/getRoomMembers/getPublicRoomMembers` 全部转发到新方法
3. 在注释里标记 deprecated

完成标志：

- 前端 API 层只保留一套 room resource 读取能力

## Phase 3：组件迁移

需要修改的重点组件：

- `frontend/src/components/dashboard/AgentBrowser.tsx`
- `frontend/src/store/useDashboardChatStore.ts`
- 其他直接调用 `getRoomMessages/getPublicRoomMessages/getRoomMembers/getPublicRoomMembers` 的组件和 store

改造原则：

- 组件不判断 public/private
- 不做 fallback
- 一律调用统一 API

完成标志：

- 组件代码不再出现 public/dashboard room resource 的试错逻辑

## Phase 4：废弃旧读接口

1. 给旧路由打 deprecated 标记
2. 更新文档
3. 清理无调用后，移除：
   - `/api/public/rooms/{room_id}/messages`
   - `/api/public/rooms/{room_id}/members`
   - `/api/dashboard/rooms/{room_id}/messages`
   - `/api/dashboard/rooms/{room_id}/members`

最终仅保留：

- `/api/rooms/{room_id}`
- `/api/rooms/{room_id}/messages`
- `/api/rooms/{room_id}/members`

## 11. 类型收敛建议

建议在前端显式区分三类类型：

- `RoomSummary`
  - 列表卡片和 overview/discover/public browse 使用
- `RoomDetail`
  - 单房间详情使用
- `RoomMessagesResponse`
  - 带 `viewer_context`
- `RoomMembersResponse`
  - 带 `viewer_context`

不要再沿用“public room 的 members 响应类型也给 dashboard 用”的做法，因为这会继续模糊语义。

## 12. 测试清单

## 12.1 Backend

新增或调整：

- 访问 public room 的 messages/members：
  - guest 成功
  - authed non-member 成功
- 访问 private room 的 messages/members：
  - member 成功
  - non-member 403/404
- 同一路由下 `viewer_context` 正确返回
- `before/after` 用 `hub_msg_id` 分页正常

## 12.2 Frontend

新增或调整：

- `api.getAccessibleRoomMessages()` 在 public/private 场景都能工作
- `api.getAccessibleRoomMembers()` 在 public/private 场景都能工作
- 组件不再依赖 fallback
- private room 不会因为误走 public 路由而报错

## 13. 最小可落地版本

如果要快速止血，建议先做下面这版：

1. 新增统一接口：
   - `/api/rooms/{room_id}/messages`
   - `/api/rooms/{room_id}/members`
2. 前端 `api.ts` 新增：
   - `getAccessibleRoomMessages`
   - `getAccessibleRoomMembers`
3. `AgentBrowser.tsx` 去掉 dashboard/public fallback
4. `useDashboardChatStore.ts` 的消息读取统一走新接口
5. 旧 public/dashboard 对应 room 读接口先保留，但标记 deprecated

这版改完之后，最容易出错的 private room 前端读路径就会先收敛下来。

## 14. 结论

本次收敛的关键不是“把 public 和 dashboard 全部合并”，而是：

- 把“按 `room_id` 读取 room 内容”的能力收敛成单入口
- 把“浏览 / 加入 / 管理”这类场景性接口继续按语义保留
- 把 public/private 的权限判断从组件层移回后端和 API 层

这样能直接降低：

- AI 误用接口
- private room 前端报错
- 组件层 fallback 复杂度
- room API 文档和类型的歧义
