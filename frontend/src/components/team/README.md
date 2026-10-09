# team/

`TeamWorkspacePage.tsx` 是 `/chats/team` 的组织工作区：组织切换和功能导航、会话列表、消息内容三栏。默认进入消息，房间是会话列表的筛选视图；成员、Agent、设置为独立页面（旧的 `view=shared`「Agent 目录」链接改写到 Agent 页）。URL 记录 `space`、`view` 和 `conversation`，初次进入后补齐组织 ID。切换组织销毁旧会话状态，切换个人/Team 保留两边最近地址。

组织房间/私聊是真正的 Hub Room（`rooms.space_id` 非空），列表、创建、加入与成员管理走 `lib/org-rooms.ts`（`/api/spaces/{id}/rooms|dms|agent-dms`，用户鉴权），消息收发与已读复用个人房间接口。会话列表每 8 秒轮询 `GET /rooms`：房间视图只列 `space_kind=room`，消息视图列房间+私聊；私聊标题用 `dm_peer_name`，与 Agent 的私聊带 Agent 徽标；未加入的全组织房间显示「加入」，加入后打开。`conversation=` 承载 room_id。

`TeamRoomPane.tsx` 组合个人聊天的 `RoomHeader` + `MessageList` + `RoomHumanComposer`：挂载时占用 UI store 的 `openedRoomId`/`focusedRoomId`、卸载时释放，并自行每 5 秒 `pollNewMessages`（Team 模式关闭了个人轮询）。列表把已加入的组织房间写入 chat store 的 `spaceRooms`，作为 `getRoomSummary` 的兜底来源；个人列表（`mergeDashboardRoomsWithHumanRooms`/`buildVisibleMessageRooms`/`RoomList`）过滤掉带 `space_id` 的房间及其 humanRooms 副本。`RoomHeader` 在 Team 下传入 `onBack`/`title`/`onOpenMembers`，隐藏加入、分享、通用加成员与设置入口。

`TeamRoomMembersDialog.tsx`（成员与 Agent）列出房间里的人和 Agent，可从组织成员/组织 active Agent 中添加；无权限添加的 Agent 显示原因而非隐藏（Agent 所有者或组织管理员才可添加），私聊不能加 Agent；移除遵循 Hub 规则（房间所有者不可移除）。

Agent 页：`TeamAgentsPage.tsx`（导航唯一的「Agent」入口，自带标题，不再套管理页标题栏）列出组织全部 active Agent（`/agent-directory`：头像、在线状态、运行环境、所有者、我的权限、房间数，所有者另有授权数与待处理申请数）。筛选标签「全部 / 我的 / 我可用 / 需要我处理」（最后一个仅在 >0 时出现），计数与排序在 `lib/team-access.ts` 的 `agentTabCounts`/`filterAgents`。行按身份给按钮（`agentRowActions`）：所有者「对话」+「管理 ›」；有权限「对话」；只读另可「申请协作」；无权限「申请权限」（`AccessRequestDialog`）；申请中「申请中 · 取消」。「对话」经 `/agent-dms` 打开组织私聊。有待我处理的申请时顶部出横幅，「处理」在对话框里打开 `AccessRequestsInbox`；等待批准加入组织的 Agent 单独列出（管理员批准/拒绝，申请人撤销）。「添加 Agent」打开 `AddAgentDialog`：从自己的 Agent 中一键添加（管理员直接 `/admission/add`，其他成员提交 `/admission` 申请），或新建（复用 `dashboard/CreateAgentDialog`，创建后同样加入/申请）。`AgentManageDrawer.tsx` 是右侧抽屉（移动端全屏）：概览；谁可以用（该 Agent 的申请 + `AgentAccessGrants`）；房间与回复（`RoomReplyModeControl` 与按人规则）；危险操作（确认后从组织移除）。管理员对他人的 Agent 只看到概览与危险操作。`AccessRequestsInbox` 批准时可改角色，协作者另填仓库路径与允许命令。导航「Agent」只显示待我处理的申请数（`store/useTeamAccessStore.ts`），不再显示 Agent 总数。申请的创建/批准/拒绝/取消会经 Human 实时频道（`human:<hu_id>`）推送 `access_request_changed`（只含 space_id、request_id、status），`DashboardApp` 转给 store：只对当前打开的组织刷新徽标、横幅、收件箱和目录行；频道重连或标签页重新可见时补拉一次。`TeamRoomPane` 用 `TeamRoomAgentAccess` 在房间头下列出每个 Agent 与我的能力，并在输入框上方提示「只在被 @ 时回复」等。成员对话框里，自己拥有的 Agent 可改本房间回复方式，并可给成员开「说话不用 @ 也回复」。设置页对所有者/管理员显示 `AccessOverviewSection`（403 时隐藏）。

`TeamConversationDialog.tsx` 使用原生模态框的焦点约束和 Escape 关闭行为，创建组织公开房间、指定成员私密房间（可勾选 Agent 一并拉入）或一对一成员私聊。组织公开房间对全体成员可见、加入后可读全部历史；私密房间仅对被加入的成员可见。

`TeamSpacesPage.tsx` 保留 `/settings/spaces` 的治理页面及无组织/待接受邀请引导；Agent 管理只留一张跳到 Agent 页的卡片。工作区通过 `section` 仅嵌入成员或设置之一。嵌入页面共用工作区的页面级 store：切换成员、设置以及补齐默认组织 URL 时复用已验证快照，不重复加载身份、组织列表和成员；独立设置页仍自行加载和复核。组织成员请求在组织列表返回后立即发起，与身份请求并行，撤权或复核失败仍清除内容。现有 API 支持邀请、接受、退出/移除、Agent 申请/审批和政策设置。

`OrgInviteLinks.tsx` 是成员区块的管理员邀请入口：生成邀请链接（有效期 1/7/30 天或永久，次数不限/1/5/20）、复制（剪贴板失败时选中文本）、系统分享、列出与撤销；按用户 ID 邀请降级为折叠的次要入口，普通成员只看到联系管理员提示。

`OrgInviteLanding.tsx` 承接 `/join/[code]`：公开预览与登录态独立加载；未登录跳 `/login?next=/join/<code>`（登录页含注册并回跳），已登录接受后进入 `/chats/team?space=`；过期/用尽/撤销/组织不可用只显示原因。

`TeamWorkspaceSkeleton.tsx` 与消息工作区三栏形态保持一致，供首次加载、鉴权等待使用。

`organization_messaging_available` 控制旧 Hub 的兼容降级。Agent 入组后可被拉进组织房间参与对话；执行能力仍由 daemon 按组织上下文独立控制。

测试包括页面结构、旧 Hub 降级、路由、API 用户身份及异步历史合并/取消/撤权。本地隔离测试数据的桌面、移动端与建房截图在 `frontend/docs/screenshots/team-workspace-*.png`；后端真实鉴权与数据库测试另见共享文档 [Team 工作区](../../../../docs/team-workspace-messaging.md)。
