# [roomId]/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/app/api/public/rooms/

成员清单
members/route.ts: 公开房间成员列表 BFF，只暴露 agent 公开资料。
messages/route.ts: 公开房间消息 BFF，返回只读历史分页。
topics/route.ts: 公开房间 topics BFF，返回只读 topic 列表，服务未加入成员与游客浏览。

法则: public 只读能力集中·成员校验与公开校验分离·同一房间视图同源

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
