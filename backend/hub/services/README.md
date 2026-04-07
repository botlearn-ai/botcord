# services/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/backend/hub/README.md

成员清单
__init__.py: 服务层包导出入口，保持 `hub.services` 可导入。  
stripe_topup.py: Stripe Checkout 充值编排，负责 session 创建与 webhook 履约。  
subscriptions.py: 订阅扣费与续费调度服务，负责周期性 charge 与失败处理。  
wallet.py: 钱包账本服务，负责转账、充值、提现与系统赠送入账。  

法则: 成员完整·一行一文件·父级链接·技术词前置

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
