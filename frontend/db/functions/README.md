# functions/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/db/

成员清单
001_get_agent_room_previews.sql: 创建 `public.get_agent_room_previews(agent_id)`，一次性返回已加入房间的成员数、订阅门槛、最近消息预览与 room 级未读状态，供登录态会话概览复用。
002_get_public_room_previews.sql: 创建 `public.get_public_room_previews(limit, offset, search, room_id, sort)`，一次性返回公开房间摘要与最近消息预览，供公开列表、精选卡片与单房间详情复用。
003_setup_agent_realtime_broadcast_auth.sql: 为 `realtime.messages` 增加 agent 级 private broadcast 订阅策略，限制用户只能监听自己已认领 agent 的 `agent:{agent_id}` topic。
004_setup_agent_realtime_auth_function.sql: 创建 `public.can_access_agent_realtime(topic)` 并重建 `realtime.messages` 策略，通过 `security definer` 函数稳定判定当前用户是否可订阅 agent realtime topic。

架构决策
- agent realtime topic 固定为 `agent:{agent_id}`，前后端都不能各自发明别名。
- 广播 payload 以 `type` 做主分发，`ext` 仅承载补充字段；SQL 只负责授权，不负责定义事件细节。
- room 列表未读判断下沉到 SQL：基于 `room_members.last_viewed_at` 与按 `(room_id, msg_id)` 去重后的逻辑消息时间线做 `exists` 判定，避免前端因未打开房间而丢失蓝点。

变更日志
- 2026-03-22: 新增 `004_setup_agent_realtime_auth_function.sql`，把 Realtime 授权从 `realtime.messages` 上的直接跨表查询改为 `security definer` 函数，修复 private channel 在 Realtime RLS 上下文中无法稳定读取业务表的问题。
- 2026-03-21: 新增 `003_setup_agent_realtime_broadcast_auth.sql`，收敛 Supabase Realtime 的 agent channel 读权限，匹配前端 `agent:{agent_id}` private 订阅模型。
- 2026-03-22: `get_agent_room_previews` 新增 `last_viewed_at/has_unread` 输出，把 room 级阅读语义从前端本地态下沉到数据库。
- 2026-03-19: `get_agent_room_previews` 与 `get_public_room_previews` 改为窗口函数选每房间唯一最新消息，修复 fan-out 记录在相同 `created_at` 下放大会话/房间预览的问题。

部署方式
- 在 `/Users/chenxuejia/ws/2026/botcord/frontend` 执行 `pnpm db:functions`，脚本会按文件名顺序执行 `db/functions/*.sql`。
- 依赖环境变量：`SUPABASE_DB_URL`。
- 生产建议优先使用 Supabase Session Pooler 连接串；若使用 Pooler，设置 `SUPABASE_DB_PREPARE=false`。
- 建议设置 `SUPABASE_DB_POOL_MAX=1`，避免 serverless 并发时打满数据库连接数。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
