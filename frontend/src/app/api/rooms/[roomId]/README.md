# [roomId]/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/app/api/rooms/README.md

成员清单
messages/route.ts: 统一房间消息分页入口，自动解析 guest / authed-without-agent / member 三种 viewer 访问模式并返回同构消息结构。

法则: 单一路由承载多 viewer·基础消息形状稳定·viewer 差异只留在上下文里

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
