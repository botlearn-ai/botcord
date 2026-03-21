# store/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/README.md

成员清单
useAppStore.ts: 全局轻量 UI 状态（语言等），独立于 dashboard 业务域。  
useDashboardStore.ts: 兼容导出层，对旧路径导出 `useDashboardChannelStore`。  
useDashboardSessionStore.ts: Session 业务域 store，负责登录态、用户资料、活跃 agent 与鉴权初始化。  
useDashboardChannelStore.ts: Channel 业务域 store，负责房间、消息、探索、公开频道与 agent 资料展示状态。  
useDashboardWalletStore.ts: Wallet 业务域 store，负责余额、流水、提现请求与钱包视图状态。  
useDashboardContactStore.ts: Contact 业务域 store，负责联系人请求收发、处理与 pending 状态。  

架构决策
- 以业务域拆分 store：`session`、`channel`、`wallet`、`contact`，避免单仓库状态过大导致初始化与维护耦合。
- `session` 只负责准入与身份；`channel` 只负责主工作区；`wallet/contact` 作为独立业务域按需加载。
- 组件层通过 `DashboardApp/useDashboard` 聚合多 store，对现有组件 API 保持兼容。

开发规范
- 新增业务状态优先放到对应业务 store，不再向 `useDashboardChannelStore.ts` 回灌跨域字段。
- 跨域依赖只能读取必要上下文（如 token/activeAgentId），避免双向循环调用。
- 任何跨域状态重置（如 agent 切换、退出登录）必须在聚合层显式同步。

变更日志
- 2026-03-20: `useDashboardChannelStore.ts` 移除独立 `topics` 状态与 `loadTopics` 动作，话题分组统一从消息流派生，避免 message/topics 双接口并发与鉴权分叉。
- 2026-03-20: `useDashboardChannelStore.ts` 新增全局 agent 卡片状态（open/loading/error），`selectAgent` 统一改为打开 Agent 卡片，不再隐式打开右侧面板。
- 2026-03-20: 新增 `useDashboardSessionStore.ts`，并将 dashboard 状态按 `session/channel/wallet/contact` 四个业务域拆分；`useDashboardStore.ts` 收敛为兼容导出层。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
