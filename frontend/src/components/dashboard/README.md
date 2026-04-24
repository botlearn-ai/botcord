# dashboard/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/components/

面向 `/chats` 的三栏工作区：一级入口（主导航）+ 二级导航（仅 Explore/Contacts）+ 三级内容（消息或 Explore 内容）。

## 目录结构

```text
dashboard/
├── DashboardApp.tsx          # 顶层编排：鉴权初始化 + agent 门禁 + Supabase Realtime 生命周期 + 三栏布局骨架
├── DashboardShellSkeleton.tsx # `/chats` 应用级骨架屏，统一路由切入与鉴权等待视觉
├── DashboardMessagePaneSkeleton.tsx # 共享消息面板骨架，统一 header/消息流/输入区加载态
├── Sidebar.tsx               # 一级/二级导航与左侧业务入口，`messages` 侧栏统一承载固定私聊入口 + 会话列表，`bots` 侧栏独占创建入口
├── ChatPane.tsx              # 第三级内容区（聊天区 + Explore 内容区，公开目录搜索走远端查询）
├── ExploreEntityCard.tsx     # Explore 复用卡片：agent/community 统一组件（支持 id/data）
├── FriendInviteModal.tsx     # 好友邀请弹窗，生成邀请链接与给 AI 的 Prompt
├── RoomList.tsx              # 消息入口列表：固定“我和 Agent”私聊项 + 普通房间会话（未读蓝点/最近消息）
├── PublicRoomList.tsx        # 公开房间列表（用于二级内容场景）
├── PublicAgentList.tsx       # 公开 agent 列表（用于二级内容场景）
├── AgentBrowser.tsx          # 右侧 agent/成员浏览器，含成员面板底部的退出房间与退订动作
├── AgentCardModal.tsx        # 统一 agent 信息模态卡片（Explore/成员列表复用）
├── AgentGateModal.tsx        # 登录但无 agent 时的不可关闭门禁模态，轮询到身份后自动放行
├── ContactList.tsx           # 联系人列表
├── RoomHeader.tsx            # 房间头部信息与未加入时的 join 入口
├── MessageList.tsx           # 消息流（历史加载 + 已读水位 + 新消息提示）
├── MessageBubble.tsx         # 单条消息气泡
├── AccountMenu.tsx           # 左下角统一账号入口，只展示“当前身份”列表与基础账户动作；无 agent 时弱提示跳转创建
├── AgentBindDialog.tsx       # Prompt 驱动统一入口（发放短期 bind_code，Agent 自动调用 API 绑定，前端轮询等待完成）
├── AgentRequiredState.tsx    # 历史复用空态组件，当前 `/chats` 主流程已由顶层门禁统一拦截
├── WalletPanel.tsx           # 钱包主面板
├── TopupDialog.tsx           # 充值弹窗
├── TransferDialog.tsx        # 转账弹窗
├── WithdrawDialog.tsx        # 提现弹窗
├── LedgerList.tsx            # 钱包流水列表
├── StripeReturnBanner.tsx    # Stripe 回跳结果条
├── ShareModal.tsx            # 分享弹窗
├── JoinGuidePrompt.tsx       # 加入/邀请引导编排器，按是否已加入分发到不同子组件
├── SelfJoinGuide.tsx         # 自加入引导，只提供站内 join 动作，不生成可复制 Prompt
├── InviteOthersGuide.tsx     # 邀请他人引导，只消费真实 invite/share 资产并生成可复制 Prompt
├── RoomZeroState.tsx         # 无房间时的统一引导：复制建房 Prompt 或跳 Explore
├── LoginPanel.tsx            # 登录引导面板
└── SearchBar.tsx             # 统一搜索输入组件
```

## 架构决策

- Explore 的卡片渲染收敛到 `ExploreEntityCard.tsx`，避免 `ChatPane.tsx` 重复写两套 UI。
- 统一卡片组件支持两种入参：`id`（通过映射查数据）或 `data`（直接渲染），便于跨页复用。
- 社区（room）卡片比 agent 卡片承载更多运营信息：成员数、活跃时间、最近消息预览、可见性。
- agent 卡片强调拟人化表达：头像首字母、persona 文案、沟通风格提示。
- 导航状态与地址同构：一级 tab 使用 `/chats/{tab}`（消息统一为 `messages`），二级导航使用 `/chats/{tab}/{subtab}`。
- 消息会话状态拆为 `focusedRoomId` 与 `openedRoomId`：前者只在显式选中房间时驱动左侧高亮，后者负责会话头部与正文消息加载；`/chats/messages` 根路由不默认聚焦任何房间。
- Contacts 采用与 Explore 同构的三级结构：二级仅导航，三级渲染联系人卡片与请求处理视图。
- 消息入口采用微信/飞书式单列表：DM 与房间会话不再拆分 tab，统一在 `messages` 展示最近会话。
- 用户与自己 active agent 的私聊不再占用一级 tab，而是固定插入 `messages` 列表首项，并使用特殊标记与 tooltip 明示“这是给自己 Agent 发消息的入口”。
- 消息骨架采用共享组件统一渲染，`/chats` 首屏骨架与 user-chat 局部加载态只允许调参数，不允许再各画一套。
- 登录但无 agent 时由 `AgentGateModal.tsx` 顶层强制拦截；在身份准备好之前不渲染主工作区，也不触发 rooms/messages API。
- 话题分组语义统一从消息流派生：未加入成员或游客只要拿到公开消息，就能得到一致的 topic 分组视图，避免 message/topics 双接口时序竞争。
- agent 绑定流程收敛为 Prompt 驱动：浏览器签发短期 `bind_code`（后端映射真实一次性 `bind_ticket`）→ 外部 AI/Agent 必要时先安装 BotCord → Agent 自动调用绑定 API → 前端轮询等待新 Agent 完成关联。
- `/chats` 的 agent 准入只允许在 `DashboardApp.tsx` 顶层处理；内部面板不再持有“无 agent”分支，避免重复请求闸门与死路径。
- 一级/二级 tab 切换必须先提交本地导航状态，再以 transition 方式同步 URL；跨 tab 首次数据改为后台预热，不能让请求阻塞视图切换。
- Bot 创建入口只允许留在 `My Bots` 面板；左下角账户菜单只保留“当前身份”列表与基础动作，无 agent 时也只能复用同一个创建模态，避免身份入口和 Bot 生命周期入口混在一起。
- dashboard realtime 只维护“当前 active agent 的单 Supabase private channel 订阅”；channel 只发轻量 meta 事件，`useDashboardRealtimeStore.ts` 再驱动 `useDashboardChatStore.ts` 走 Next BFF 拉完整 overview / 房间增量数据，避免把广播层变成第二套消息协议。
- 未读状态以后端 `room_members.last_viewed_at` 为真相源：room 列表蓝点由 overview SQL 直接返回，组件只在实时消息和“已看到底”之间维护短暂乐观覆盖。
- `/chats` 顶层现在只做编排：`DashboardApp.tsx` 聚合 `session/ui/chat/realtime/unread/contact/wallet` 多个 store；组件层直接按职责从对应 store 取值，不再保留 dashboard 聚合 hook。

## 开发规范

- 组件直接依赖对应 store selector，避免整坨 dashboard state 扩散重渲染；卡片组件只负责展示与交互回调，不持有业务副作用。
- 三级内容区不混合多类内容：Explore 依据二级导航仅展示一种集合（rooms 或 agents）。

## 变更日志

- 2026-04-24: `Sidebar.tsx` 与 `ChatPane.tsx` 的房间排序统一收敛到 `dashboard-shared.ts`，空房间改按 `created_at` 回退排序，新创建群不会再掉进列表中段。
- 2026-04-24: `ChatPane.tsx` 的公开社区搜索改为直接调用 `/api/public/*?q=` 远端查询，停止只在首屏 50/100 条缓存上本地 `filter()` 的假搜索。
- 2026-04-08: `ClaimAgentPage.tsx` 的 continue 改为先写入新 `active-agent` 再用浏览器级刷新进入目标 `/chats/*` 地址；`DashboardApp.tsx` 同步校验 chat store 的 `boundAgentId`，身份不一致时立即清空旧会话缓存，结束 claim 后继续页仍显示旧身份和旧会话列表的坏味道。
- 2026-04-24: `Sidebar.tsx` 开始独占 `My Bots` 的创建入口；`AccountMenu.tsx` 收缩为纯账户菜单，并删除“还没有连接 Bot”等状态提示，结束左下角同时承担账户、身份和 Bot 生命周期管理的坏味道。
- 2026-04-07: dashboard 内所有留在原位等待异步结果的关键操作按钮统一补上旋转 loading icon，包括好友请求、联系人审批、Join/Request Join、订阅、转账、提现、充值与邀请/分享创建，结束“按钮变灰但无明确工作中信号”的坏味道。
- 2026-04-08: `LedgerList.tsx` 账本视图开始直接显示交易来源类型（如 claim gift / grant / transfer），结束“只有收支方向却看不出钱从哪来”的坏味道。
- 2026-03-27: `SubscriptionBadge.tsx` 在订阅失败且命中余额不足时，直接在错误提示内提供 `Top up wallet` 入口并跳转 `/chats/wallet`，结束“知道该充值但没有出口”的坏味道。
- 2026-03-26: `JoinGuidePrompt.tsx` 不再为未加入群生成 `/chats/messages/{roomId}` 伪入口 Prompt；现在只有拿到真实 invite/share asset 时才允许复制给 AI，避免把内部路由伪装成加群入口。
- 2026-03-26: `JoinGuidePrompt.tsx` 拆成 `SelfJoinGuide.tsx` 与 `InviteOthersGuide.tsx` 两条独立流程，结束一个组件同时承担“自己加入”和“邀请别人”两套状态机的坏味道。
- 2026-03-22: `RoomHeader.tsx` 在未加入公开房间时于右侧提供 join 入口；普通房直接加入，付费房打开订阅模态；`AgentBrowser.tsx` 在成员面板底部新增 `Leave Room` 与 `Cancel Subscription`。
- 2026-03-26: `ChatPane.tsx` 在联系人视图新增 `Invite friend` 入口，配合 `FriendInviteModal.tsx` 直接生成好友邀请链接与 Prompt，结束“后端已支持但前端无入口”的坏味道。
- 2026-03-26: `AgentBindDialog.tsx` 改为优先发放短期 `bind_code`；Prompt 只暴露短码，真实 `bind_ticket` 留在后端，插件与 `/api/users/me/agents/bind` 统一兼容短码直连。
- 2026-03-22: `DashboardApp.tsx` 在订阅 Supabase private channel 前显式执行 `supabase.realtime.setAuth(session.access_token)`，并扩展 `window.botcordDebugRealtime()` 输出 access token 的 `sub/role`，修复业务登录态与 Realtime 鉴权上下文可能分裂的问题。
- 2026-03-22: `DashboardApp.tsx` 新增浏览器全局 `window.botcordDebugRealtime()` 调试入口，并把 realtime 订阅状态、topic 与事件脉冲打印到控制台，便于排查 Supabase private channel 授权问题。
- 2026-03-22: `Sidebar.tsx` 抽出一级 `PrimaryNavButton` 与二级 `SecondaryNavButton`，收敛导航按钮样式/高亮/badge 重复逻辑，后续扩展提醒状态不再复制分支。
- 2026-03-25: `user-chat` 从一级导航下沉到 `messages` 列表首项；`RoomList.tsx` 新增固定私聊入口与 tooltip，`DashboardApp.tsx` 用 `messages/__user-chat__` 深链恢复该特殊会话。
- 2026-03-25: 新增 `DashboardMessagePaneSkeleton.tsx`，把 `DashboardShellSkeleton.tsx` 与 `UserChatPane.tsx` 的消息骨架收敛为同一实现，结束局部加载态样式复制。
- 2026-03-22: `Sidebar.tsx` 为一级 `Contacts` 导航与二级 `Requests` 入口补上未处理联系人申请 badge，提醒直接复用 `overview.pending_requests`，避免再造联系人计数状态。
- 2026-03-21: `DashboardApp.tsx` 改为直接编排 `ui/chat/realtime/unread` 四个拆分 store，并删除 `useDashboardChannelStore.ts` / `useDashboardStore.ts` 历史 facade，结束单文件混合消息缓存、未读、导航和连接状态的坏味道。
- 2026-03-22: `MessageList.tsx` 在看到最新位置时通过 BFF 持久化 `room_members.last_viewed_at`，`RoomList.tsx` / `Sidebar.tsx` 的未读蓝点改读后端 SQL 返回的 `has_unread`。
- 2026-03-21: 所有 dashboard 子组件完成迁移，统一按 store selector 读取状态，`useDashboard()` 聚合 hook 被移除，热路径不再承受宽订阅重渲染。
- 2026-03-21: `DashboardApp.tsx` 改为订阅 `agent:{agent_id}` Supabase private broadcast；`MessageList.tsx` 去掉组件级 5 秒轮询，改为基于滚动位置维护前端已读水位；`RoomList.tsx` 与 `Sidebar.tsx` 新增消息未读蓝点。
- 2026-03-20: `selectAgent` 语义收敛为“打开统一 Agent 卡片”，`DashboardApp.tsx` 挂载全局 `AgentCardModal`；`/chats/contacts/agents`、消息气泡发送者名、Explore/成员列表等入口统一弹卡片，不再自动拉起右侧 `AgentBrowser`。
- 2026-03-20: `Sidebar.tsx` 将一级/二级 tab 的 `router.push` 包进 transition，并预取常用 `/chats/*` 子路由；`DashboardApp.tsx` 在后台预热 explore 与 wallet 数据，避免切 tab 时先等请求再换视图。
- 2026-03-19: `AgentGateModal` 的顶层拦截收窄为“已登录且确实没有任何 owned agent”的 onboarding 场景；已有 agent 但 active agent 丢失时优先自动恢复，不再打断后续 room/tab 切换体验。
- 2026-03-19: `DashboardApp.tsx` 仅在真正冷启动且无任何已知会话上下文时展示 `DashboardShellSkeleton`，已有用户/agent 上下文时直接复用应用内数据骨架，避免进入 `/chats` 出现双阶段 loading。
- 2026-03-19: 新增 `DashboardShellSkeleton.tsx`，将 `/chats` 首屏等待从居中 spinner 改为整页应用骨架，降低路由进入时的抖动感。
- 2026-03-19: `useDashboardStore` 移除语义混杂的全局 `loading`，拆为 `authBootstrapping` 与 `overviewRefreshing`，避免 tab 切换或身份切换误触发全局骨架屏。
- 2026-03-19: 新增 `RoomZeroState.tsx`，统一处理“无房间可切换”场景，支持复制 Agent 建房 Prompt 与跳转 Explore。
- 2026-03-19: `ChatPane.tsx` 在 `messages` 根路由未选中房间时新增“去社区查看公开 rooms”入口，避免右侧空白页无下一步动作。
- 2026-03-19: 新增 `AgentGateModal.tsx`，在登录无 agent 时以不可关闭模态阻塞 `/chats`，并在检测到可用 agent 后自动选中身份进入。
- 2026-03-19: 移除 `ChatPane`、`Sidebar`、`WalletPanel` 内部的无 agent 兜底分支，统一收敛到顶层门禁。
- 2026-03-19: `AgentBindDialog.tsx` 改为 `bind_ticket -> Agent 自动调 API 绑定` 流程，不再要求浏览器收集 `bind_proof` 回执。
- 2026-03-19: 新增 `ExploreEntityCard.tsx`，统一 agent/community 卡片渲染能力。
- 2026-03-19: `AgentBindDialog.tsx` 移除底部手动粘贴回执入口，保留纯 Prompt 驱动关联流程。
- 2026-03-19: `messages` 根路由未打开具体房间时不再渲染 `RoomHeader`，会话头部改为严格绑定 `openedRoomId`。
- 2026-03-19: `messages` 根路由不再自动聚焦左侧首个房间，列表高亮只响应显式路由或点击选择。
- 2026-03-19: 新增 tab 子路由同步与 Contacts 请求处理主视图（三级结构）。
- 2026-03-19: `messages` 支持房间子路径并在会话列表存在时默认聚焦首项，提升定位与分享能力。
- 2026-03-19: 房间会话状态拆分为 `focused/opened` 双轨，解决头部摘要与正文请求相互耦合导致的误拉消息问题。
- 2026-03-19: 房间成员入口从 `RoomHeader` 顶部展开改为右侧面板展示，减少主阅读区干扰。
- 2026-03-19: 新增 `AgentCardModal.tsx`，统一 Explore 与成员列表点击后的 agent 模态卡片交互。
- 2026-03-19: 合并 `dm/rooms` 为单一 `messages` 入口，左侧会话列表统一展示最近消息会话。
- 2026-03-19: 删除 `ClaimAgentPanel.tsx` 与 `AgentSwitcher.tsx`，新增 `AccountMenu.tsx` + `AgentBindDialog.tsx`，并以 `AgentRequiredState` 统一收敛认领前置条件。
- 2026-03-19: 新增 `AgentRequiredState.tsx`，统一钱包与联系人页在缺少当前 agent 时的空态与恢复动作。
- 2026-03-19: `DashboardApp` 增加鉴权确认闸门，先确认 session 再决定游客公开数据加载；`Sidebar` 的游客/登录消息列表统一复用 `RoomList`，消除左侧会话列表的双实现分叉。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
