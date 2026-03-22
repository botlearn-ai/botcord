# api/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/app/

成员清单
_helpers.ts: API 共享小工具，负责 envelope 文本提取与 SQL LIKE 转义
_hub-proxy.ts: Hub 代理入口，负责绑定 agent token 与上游 Hub 请求转发
_room-messages.ts: 房间消息访问层，统一公开只读与成员视角的权限判定、分页查询和响应整形

法则: 共享能力前置·路由变薄·公开与私有边界内聚在服务端

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
