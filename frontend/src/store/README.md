# store/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/README.md

成员清单
useAppStore.ts: 全局轻量 UI 状态（语言等），独立于 dashboard 业务域。  
dashboard-shared.ts: dashboard 多 store 共享的房间摘要、时间比较与增量拉取辅助函数。  
useDashboardSessionStore.ts: Session 业务域 store，负责登录态、用户资料、活跃 agent 与鉴权初始化。  
useDashboardUIStore.ts: 纯界面状态 store，负责 tab、消息特殊入口选择、房间焦点、右侧面板与 Agent 卡片开合。  
useDashboardChatStore.ts: Chat 数据 store，负责 overview、消息缓存、公开房间/Agent 与 Agent 卡片数据。  
useDashboardRealtimeStore.ts: Realtime 协调 store，负责 Supabase channel 连接状态与“事件 -> 最小同步”决策。  
useDashboardUnreadStore.ts: 阅读语义 store，负责后端 `last_viewed_at` 的本地乐观覆盖与 room 级未读协调。  
useDashboardWalletStore.ts: Wallet 业务域 store，负责余额、流水、提现请求与钱包视图状态。  
useDashboardContactStore.ts: Contact 业务域 store，负责联系人请求收发、处理与 pending 状态。  
useDashboardSubscriptionStore.ts: Subscription 业务域 store，负责当前 agent 的订阅列表、商品订阅状态与订阅/退订刷新。  

架构决策
- 以职责而不是“一个大频道域”拆分 store：`session`、`ui`、`chat`、`realtime`、`unread`、`wallet`、`contact`、`subscription`。
- `session` 只负责身份；`ui` 只负责导航；`chat` 只负责数据；`realtime` 只负责连接与同步决策；`unread` 只负责阅读语义；`subscription` 只负责订阅真相。
- `ui` store 中的 `messagesPane` 只负责区分普通房间与固定私聊入口；真实消息数据仍然留在 `chat` store，避免再次把导航语义和消息缓存揉成一团。
- 组件层统一通过 `DashboardApp/useDashboard` 聚合多 store，不再保留历史 facade；状态真相只存在于拆分后的业务 store。
- realtime 不直接把 Supabase broadcast 当消息源；channel 只负责投递 meta 脉冲，`realtime/chat` store 负责通过 Next BFF 拉取最新 overview / 当前房间增量消息并合并本地状态。
- realtime 事件以 `type` 作为唯一分发语义，`ext` 只承载附加字段；不要再引入第二个 `kind/category` 制造重复含义。
- 已读未读以数据库为真相源：`room_members.last_viewed_at` 持久化成员级阅读水位，`unread` store 只保留本地乐观覆盖与 realtime 瞬时提示，不再单独定义持久化规则。

开发规范
- 新增业务状态优先放到对应业务 store，不再向 `DashboardApp` 回灌跨域字段。
- 跨域依赖只能读取必要上下文（如 token/activeAgentId），避免双向循环调用。
- 任何跨域状态重置（如 agent 切换、退出登录）必须在聚合层显式同步。
- Supabase realtime 在线时，消息更新必须走 `useDashboardRealtimeStore.ts` 的同步动作；不要重新引入组件级定时轮询制造第二数据入口。
- 进入房间并真正看到最新位置后，必须通过 BFF 写回 `last_viewed_at`；前端本地蓝点只能做短暂覆盖，不能替代后端状态。

变更日志
- 2026-03-25: `useDashboardUIStore.ts` 新增 `messagesPane`，把“固定私聊入口”和普通房间选择拆开，避免再用一级 tab 承载同属 `messages` 域的特殊会话。
- 2026-03-22: 新增 `useDashboardSubscriptionStore.ts`，把付费房间的订阅状态从 `SubscriptionBadge.tsx` 组件内缓存上收回到业务 store，统一支撑 Header join、订阅弹窗与成员面板底部的退订动作。
- 2026-03-21: 删除 `useDashboardChannelStore.ts` 与 `useDashboardStore.ts`，dashboard store 完全收敛为 `session/ui/chat/realtime/unread/wallet/contact` 七个职责域，结束兼容壳长期滞留。
- 2026-03-22: `useDashboardUnreadStore.ts` 从纯前端 `lastSeenAtByRoom/unreadRoomIds` 改为后端 `room_members.last_viewed_at` 的乐观覆盖层；room 列表未读判断下沉到 `get_agent_room_previews()` SQL。
- 2026-03-21: 新增 `useDashboardUIStore.ts`、`useDashboardChatStore.ts`、`useDashboardRealtimeStore.ts`、`useDashboardUnreadStore.ts` 与 `dashboard-shared.ts`，把原先过重的 channel 状态仓拆成单一职责结构。
- 2026-03-21: `useDashboardChannelStore.ts` 新增 realtime 概览同步、`lastSeenAtByRoom/unreadRoomIds` 前端未读模型，并在 agent 切换时重置频道域缓存，避免跨 agent 残留消息状态。
- 2026-03-20: `useDashboardChannelStore.ts` 移除独立 `topics` 状态与 `loadTopics` 动作，话题分组统一从消息流派生，避免 message/topics 双接口并发与鉴权分叉。
- 2026-03-20: `useDashboardChannelStore.ts` 新增全局 agent 卡片状态（open/loading/error），`selectAgent` 统一改为打开 Agent 卡片，不再隐式打开右侧面板。
- 2026-03-20: 新增 `useDashboardSessionStore.ts`，并将 dashboard 状态按 `session/channel/wallet/contact` 四个业务域拆分；`useDashboardStore.ts` 收敛为兼容导出层。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
