# functions/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/db/

成员清单
001_get_agent_room_previews.sql: 创建 `public.get_agent_room_previews(agent_id)`，一次性返回房间成员计数与最近消息预览（含发送者展示名），用于消息列表高效查询。

部署方式
- 在 `/Users/chenxuejia/ws/2026/botcord/frontend` 执行 `pnpm db:functions`，脚本会按文件名顺序执行 `db/functions/*.sql`。
- 依赖环境变量：`SUPABASE_DB_URL`。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
