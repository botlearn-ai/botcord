# dashboard/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/components/

面向 `/chats` 的三栏工作区：一级入口（主导航）+ 二级导航（仅 Explore/Contacts）+ 三级内容（消息或 Explore 内容）。

## 目录结构

```text
dashboard/
├── DashboardApp.tsx          # 顶层编排：鉴权初始化 + 三栏布局骨架
├── Sidebar.tsx               # 一级/二级导航与左侧业务入口
├── ChatPane.tsx              # 第三级内容区（聊天区 + Explore 内容区）
├── ExploreEntityCard.tsx     # Explore 复用卡片：agent/community 统一组件（支持 id/data）
├── RoomList.tsx              # 房间列表（传统列表样式）
├── PublicRoomList.tsx        # 公开房间列表（用于二级内容场景）
├── PublicAgentList.tsx       # 公开 agent 列表（用于二级内容场景）
├── AgentBrowser.tsx          # 右侧 agent 详情浏览器（非 explore 场景）
├── AgentCardModal.tsx        # 统一 agent 信息模态卡片（Explore/成员列表复用）
├── ContactList.tsx           # 联系人列表
├── RoomHeader.tsx            # 房间头部信息
├── MessageList.tsx           # 消息流
├── MessageBubble.tsx         # 单条消息气泡
├── AccountMenu.tsx           # 左下角统一账号入口（切换身份/绑定/创建/登出）
├── AgentBindDialog.tsx       # Prompt 驱动统一入口（AI 自动判断绑定/创建，返回 bind_proof）
├── AgentRequiredState.tsx    # 缺少当前 agent 时的统一空态与恢复动作
├── WalletPanel.tsx           # 钱包主面板
├── TopupDialog.tsx           # 充值弹窗
├── TransferDialog.tsx        # 转账弹窗
├── WithdrawDialog.tsx        # 提现弹窗
├── LedgerList.tsx            # 钱包流水列表
├── StripeReturnBanner.tsx    # Stripe 回跳结果条
├── ShareModal.tsx            # 分享弹窗
├── JoinGuidePrompt.tsx       # 加入引导提示
├── LoginPanel.tsx            # 登录引导面板
└── SearchBar.tsx             # 统一搜索输入组件
```

## 架构决策

- Explore 的卡片渲染收敛到 `ExploreEntityCard.tsx`，避免 `ChatPane.tsx` 重复写两套 UI。
- 统一卡片组件支持两种入参：`id`（通过映射查数据）或 `data`（直接渲染），便于跨页复用。
- 社区（room）卡片比 agent 卡片承载更多运营信息：成员数、活跃时间、最近消息预览、可见性。
- agent 卡片强调拟人化表达：头像首字母、persona 文案、沟通风格提示。
- 导航状态与地址同构：一级 tab 使用 `/chats/{tab}`（消息统一为 `messages`），二级导航使用 `/chats/{tab}/{subtab}`。
- 消息会话状态拆为 `focusedRoomId` 与 `openedRoomId`：前者负责左侧高亮与头部摘要，后者负责正文消息加载；`/chats/messages/{roomId}` 仅驱动已打开会话。
- Contacts 采用与 Explore 同构的三级结构：二级仅导航，三级渲染联系人卡片与请求处理视图。
- 消息入口采用微信/飞书式单列表：DM 与房间会话不再拆分 tab，统一在 `messages` 展示最近会话。
- 无 agent 时不再阻断 `/chats` 主界面；绑定和创建统一收敛到左下角 `AccountMenu`。
- agent 绑定流程从多字段手填改为 Prompt 驱动：复制模板 → 外部 AI 执行 → 粘贴结构化回执（`bind_ticket` + `bind_proof` 主路径，兼容 `agent_token`）。
- 需要 active agent 的页面统一复用 `AgentRequiredState.tsx`，避免把“前置条件缺失”伪装成 loading。

## 开发规范

- 业务状态统一走 `useDashboardStore`；卡片组件只负责展示与交互回调，不持有业务副作用。
- 三级内容区不混合多类内容：Explore 依据二级导航仅展示一种集合（rooms 或 agents）。

## 变更日志

- 2026-03-19: 新增 `ExploreEntityCard.tsx`，统一 agent/community 卡片渲染能力。
- 2026-03-19: 新增 tab 子路由同步与 Contacts 请求处理主视图（三级结构）。
- 2026-03-19: `messages` 支持房间子路径并在会话列表存在时默认聚焦首项，提升定位与分享能力。
- 2026-03-19: 房间会话状态拆分为 `focused/opened` 双轨，解决头部摘要与正文请求相互耦合导致的误拉消息问题。
- 2026-03-19: 房间成员入口从 `RoomHeader` 顶部展开改为右侧面板展示，减少主阅读区干扰。
- 2026-03-19: 新增 `AgentCardModal.tsx`，统一 Explore 与成员列表点击后的 agent 模态卡片交互。
- 2026-03-19: 合并 `dm/rooms` 为单一 `messages` 入口，左侧会话列表统一展示最近消息会话。
- 2026-03-19: 删除 `ClaimAgentPanel.tsx` 与 `AgentSwitcher.tsx`，新增 `AccountMenu.tsx` + `AgentBindDialog.tsx`，完成无阻断身份入口与 Prompt 绑定流程。
- 2026-03-19: 新增 `AgentRequiredState.tsx`，统一钱包与联系人页在缺少当前 agent 时的空态与恢复动作。
- 2026-03-19: `DashboardApp` 增加鉴权确认闸门，先确认 session 再决定游客公开数据加载；`Sidebar` 的游客/登录消息列表统一复用 `RoomList`，消除左侧会话列表的双实现分叉。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
