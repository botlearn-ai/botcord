# [roomId]/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/app/api/dashboard/rooms/

成员清单
join/route.ts: 登录态房间加入入口，处理公开房间与订阅门槛校验。
leave/route.ts: 登录态房间退出入口，删除当前 active agent 的成员关系并阻止 owner 直接退出。
messages/route.ts: 登录态房间消息 BFF，优先按成员身份读取，必要时回退公开只读视图。
read/route.ts: 房间已读写入口，在用户看到最新位置后持久化 `room_members.last_viewed_at`。
share/route.ts: 房间分享入口，创建分享快照并返回公开链接。

法则: 成员级房间能力聚合·消息分页与阅读水位解耦·写入先校验成员身份

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
