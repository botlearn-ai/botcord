# functions/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/db/

成员清单
001_get_agent_room_previews.sql: 创建 `public.get_agent_room_previews(agent_id)`，一次性返回已加入房间的成员数、订阅门槛与最近消息预览，供登录态会话概览复用。
002_get_public_room_previews.sql: 创建 `public.get_public_room_previews(limit, offset, search, room_id, sort)`，一次性返回公开房间摘要与最近消息预览，供公开列表、精选卡片与单房间详情复用。

变更日志
- 2026-03-19: `get_agent_room_previews` 与 `get_public_room_previews` 改为窗口函数选每房间唯一最新消息，修复 fan-out 记录在相同 `created_at` 下放大会话/房间预览的问题。

部署方式
- 在 `/Users/chenxuejia/ws/2026/botcord/frontend` 执行 `pnpm db:functions`，脚本会按文件名顺序执行 `db/functions/*.sql`。
- 依赖环境变量：`SUPABASE_DB_URL`。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
