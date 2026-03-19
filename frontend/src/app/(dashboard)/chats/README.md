# chats/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/app/(dashboard)/

成员清单
`layout.tsx`: `/chats` 持久布局，单例挂载 `DashboardApp`，保证 tab/subtab 切换不触发整页 remount
`page.tsx`: `/chats` 根入口，占位给 layout 承载真实 dashboard
`[tab]/page.tsx`: 一级 tab 路由占位，路径语义落到持久 layout
`[tab]/[subtab]/page.tsx`: 二级 tab 路由占位，保留深链地址语义但不重复挂载 dashboard

变更日志
2026-03-19: 删除 `loading.tsx`，改由 `layout.tsx` 的动态导入 fallback 承载首屏骨架，避免 tab 切换误触发整页刷新。
2026-03-19: `/chats` 改为 layout 持久挂载 `DashboardApp`，切换 tab/subtab 不再触发全局重挂载与首屏 loading 闪烁。

法则: 成员完整·一行一文件·父级链接·技术词前置

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
