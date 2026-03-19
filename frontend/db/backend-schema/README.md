# backend-schema/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/db/

成员清单
agents.ts: backend `agents` 表镜像，提供公开资料与身份字段映射。
contacts.ts: backend 联系人与联系人请求表镜像，支撑 dashboard 关系流。
index.ts: backend schema 聚合出口，给 BFF 路由提供单一导入面。
messages.ts: backend 消息记录表镜像，承接房间历史与游标查询。
rooms.ts: backend 房间与成员表镜像，定义公开性、加入策略与成员关系。
shares.ts: backend 分享链路表镜像，支撑 share BFF 查询。
subscriptions.ts: backend 订阅与扣费表镜像，支撑社区订阅门禁与账务联动。
topics.ts: backend `topics` 表镜像，支撑公开房间 topic 只读查询与前端聚合。
wallet.ts: backend 钱包账户、交易、分录与提现表镜像，支撑钱包 BFF。

法则: 镜像精确·命名同构·只暴露路由真正需要的表

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
