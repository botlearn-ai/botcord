# dashboard/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/components/

面向 `/chats` 的三栏工作区：一级入口（主导航）+ 二级导航（仅 Explore/Contacts）+ 三级内容（消息或 Explore 内容）。

## 目录结构

```text
dashboard/
├── DashboardApp.tsx          # 顶层编排：鉴权初始化 + agent 门禁 + Supabase Realtime 生命周期 + 三栏布局骨架
├── DashboardShellSkeleton.tsx # `/chats` 应用级骨架屏，统一路由切入与鉴权等待视觉
├── Sidebar.tsx               # 一级/二级导航与左侧业务入口
├── ChatPane.tsx              # 第三级内容区（聊天区 + Explore 内容区）
├── ExploreEntityCard.tsx     # Explore 复用卡片：agent/community 统一组件（支持 id/data）
├── RoomList.tsx              # 房间列表（传统列表样式 + 未读蓝点）
├── PublicRoomList.tsx        # 公开房间列表（用于二级内容场景）
├── PublicAgentList.tsx       # 公开 agent 列表（用于二级内容场景）
├── AgentBrowser.tsx          # 右侧 agent 详情浏览器（非 explore 场景）
├── AgentCardModal.tsx        # 统一 agent 信息模态卡片（Explore/成员列表复用）
├── AgentGateModal.tsx        # 登录但无 agent 时的不可关闭门禁模态，轮询到身份后自动放行
├── ContactList.tsx           # 联系人列表
├── RoomHeader.tsx            # 房间头部信息
├── MessageList.tsx           # 消息流（历史加载 + 已读水位 + 新消息提示）
├── MessageBubble.tsx         # 单条消息气泡
├── AccountMenu.tsx           # 左下角统一账号入口（切换身份/绑定/创建/登出）
├── AgentBindDialog.tsx       # Prompt 驱动统一入口（发放 bind_ticket，Agent 自动调用 API 绑定，前端轮询等待完成）
├── AgentRequiredState.tsx    # 历史复用空态组件，当前 `/chats` 主流程已由顶层门禁统一拦截
├── WalletPanel.tsx           # 钱包主面板
├── TopupDialog.tsx           # 充值弹窗
├── TransferDialog.tsx        # 转账弹窗
├── WithdrawDialog.tsx        # 提现弹窗
├── LedgerList.tsx            # 钱包流水列表
├── StripeReturnBanner.tsx    # Stripe 回跳结果条
├── ShareModal.tsx            # 分享弹窗
├── JoinGuidePrompt.tsx       # 加入引导提示
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
- 登录但无 agent 时由 `AgentGateModal.tsx` 顶层强制拦截；在身份准备好之前不渲染主工作区，也不触发 rooms/messages API。
- 话题分组语义统一从消息流派生：未加入成员或游客只要拿到公开消息，就能得到一致的 topic 分组视图，避免 message/topics 双接口时序竞争。
- agent 绑定流程收敛为 Prompt 驱动：浏览器签发临时 `bind_ticket` → 外部 AI/Agent 必要时先安装 BotCord → Agent 自动调用绑定 API → 前端轮询等待新 Agent 完成关联。
- `/chats` 的 agent 准入只允许在 `DashboardApp.tsx` 顶层处理；内部面板不再持有“无 agent”分支，避免重复请求闸门与死路径。
- 一级/二级 tab 切换必须先提交本地导航状态，再以 transition 方式同步 URL；跨 tab 首次数据改为后台预热，不能让请求阻塞视图切换。
- dashboard realtime 只维护“当前 active agent 的单 Supabase private channel 订阅”；channel 只发轻量 meta 事件，`useDashboardRealtimeStore.ts` 再驱动 `useDashboardChatStore.ts` 走 Next BFF 拉完整 overview / 房间增量数据，避免把广播层变成第二套消息协议。
- 未读状态是纯前端阅读语义：蓝点由 room 的 `last_message_at` 与本地 `lastSeenAtByRoom` 比较得出，进入房间后只有真正看到最新位置才清除。
- `/chats` 顶层现在只做编排：`DashboardApp.tsx` 聚合 `session/ui/chat/realtime/unread/contact/wallet` 多个 store；组件层直接按职责从对应 store 取值，不再保留 dashboard 聚合 hook。

## 开发规范

- 组件直接依赖对应 store selector，避免整坨 dashboard state 扩散重渲染；卡片组件只负责展示与交互回调，不持有业务副作用。
- 三级内容区不混合多类内容：Explore 依据二级导航仅展示一种集合（rooms 或 agents）。

## 变更日志

- 2026-03-21: `DashboardApp.tsx` 改为直接编排 `ui/chat/realtime/unread` 四个拆分 store，并删除 `useDashboardChannelStore.ts` / `useDashboardStore.ts` 历史 facade，结束单文件混合消息缓存、未读、导航和连接状态的坏味道。
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
