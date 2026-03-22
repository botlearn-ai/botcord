# rooms/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/app/api/

成员清单
[roomId]/messages/route.ts: 统一房间消息入口，内部按当前 viewer 自动分流 member/public 访问模式，但对前端保持单一协议。

法则: 协议统一优先于 viewer 分叉·权限内聚在服务端·消息事实字段保持同构

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
