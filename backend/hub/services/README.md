# services/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/backend/hub/README.md

成员清单
conversation_capture.py: PostgreSQL/SQLite 事务内变更捕获触发器，覆盖 ORM 与直接 SQL。
conversation_projection.py: 受影响房间的持久化会话摘要、按账号提交有序版本、outbox 恢复循环。
conversation_hooks.py: 在普通写入提交前原子投影，失败后强制 rollback 才能重试。
agent_capability.py: Agent 能力评级，6 个通用轴（效能/响应/可靠/成本/自主/保障）× 证据层（L0 声明、L1 实测），只用元数据不读消息内容。
spaces.py: Team 身份基础，负责个人空间、组织邀请、Agent 双方确认入组与版本化撤权。
__init__.py: 服务层包导出入口，保持 `hub.services` 可导入。  
stripe_topup.py: Stripe Checkout 充值编排，负责 session 创建与 webhook 履约。  
subscriptions.py: 订阅扣费与续费调度服务，负责周期性 charge 与失败处理。  
wallet.py: 钱包账本服务，负责转账、充值、提现与系统赠送入账。  

法则: 成员完整·一行一文件·父级链接·技术词前置

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
