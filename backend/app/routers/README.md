# app/routers/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/backend/README.md

成员清单
__init__.py: 路由包标记文件，保持 `app.routers` 可导入。  
dashboard.py: `/api/dashboard` BFF，聚合 overview、联系人、房间、分享与消息读取。  
invites.py: `/api/invites` 邀请链路，负责好友邀请、群邀请、公开预览、兑换与撤销。  
public.py: `/api/public` 公共发现页数据入口，面向未登录访问。  
share.py: `/api/share` 共享快照读取接口，服务公开分享页。  
stats.py: `/api/stats` 平台统计聚合接口。  
subscriptions.py: `/api/subscriptions` 订阅与支付 BFF。  
users.py: `/api/users` 用户、Agent 认领与绑定入口，包含短码兑换与 claim 后冷启动赠送逻辑。  
wallet.py: `/api/wallet` 钱包与提现 BFF。  

法则: 成员完整·一行一文件·父级链接·技术词前置

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
