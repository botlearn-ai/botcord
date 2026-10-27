# Messages 缓存与游标同步

## 用户体验

Supabase 恢复账号后，按 Hub 环境和账号 ID 同步读取本地会话摘要、分组、Bot 筛选和同步游标。鉴权初始化期间加载壳展示不可交互的缓存列表；鉴权完成后切换到正常列表。首次无缓存时读取最新 100 个摘要，再分页补齐。旧 Human 成员接口只在身份初始化完成后后台加载，不阻塞首屏。

缓存与消息历史分开，不保存 token，也不授予接口权限。退出登录清除当前账号的目录缓存；切换账号隔离数据和进行中请求。网络失败保留列表。旧缓存没有游标时仍可先显示，再通过新快照替换。

目录按最后有效 message/system 时间倒序，同时间以房间 ID 稳定排序，无消息房间置后；渲染层继续支持置顶和隐藏水位。时间、作者、预览统一来自摘要，typing、ack、result、error、状态回执不更新活动时间。撤回更新预览但不抬高时间。多个自有 Bot 共处一个房间时保留全部来源。

## 持久化读取模型

四张表将列表读取从消息历史聚合中分离。PostgreSQL 启用 RLS 且不开放客户端策略，避免通过 Supabase 表接口绕过 Hub 读取私有摘要；Hub 数据库角色须为表所有者或具备 BYPASSRLS：

| 表 | 用途 |
| --- | --- |
| conversation_dirty_rooms | 同事务合并待更新房间的 outbox；每房间一行，更新 generation 获取写锁，writer_xid 标识本次写事务 |
| conversation_accounts | 每账号 epoch、版本和保留日志下界 |
| conversation_entries | 每账号/房间的当前摘要、活动时间、未读、权限、来源和删除标记 |
| conversation_changes | 每账号按提交顺序分配的版本及变化房间 ID |

数据库触发器捕获 rooms、room_members、有效 message_records 及 Agent/User 身份、名称、头像的相关变化，覆盖 ORM、批量 SQL 和外部脚本。成员删除、房间删除、Bot 所有权转移也会捕获；投递/响应状态更新不触发消息摘要重建。名称/头像变化也会更新其作为成员或最后发送者出现的摘要。

正常 Hub AsyncSession 写入在 before_commit 中只刷新本事务影响房间的摘要、追加变化，再与原始写入一起提交，不接管其它房间的积压回填。writer_xid 仅用于筛选本事务的 outbox 行，不作为同步游标；投影异常禁止提交，调用方必须 rollback 后重试。直接 SQL 或超过单批 500 房间的导入通过后台恢复任务补齐（每 0.5 秒检查一次）。outbox 删除和投影在同一事务中，崩溃会回滚并保留重试依据。数据库触发器不依赖进程内标记。

投影器使用 FOR UPDATE SKIP LOCKED 领取房间，然后按稳定账号顺序锁住 conversation_accounts 再递增版本。后一个版本不能早于前一个版本提交，避免使用全局自增序号当游标时的乱序提交漏读。并发写入遇到正在处理的 outbox 行会等待并重新更新/插入，不会被旧任务删除。重放不变摘要不追加版本。

**成本边界：**常规同步读取不访问 message_records。当前写入投影仍对受影响房间聚合历史及未读，并不是 O(1) 的消息计数器；一个房间有很多用户时还存在按账号的投影开销。未读保留原语义：同一逻辑消息只算一次，排除自己的消息、回执、已撤回消息，遵守成员 last_viewed_at。没有采用不准确的“最后序号减已读序号”。如大群/极长单房间历史使写入延迟显著上升，可继续拆分共享房间摘要和增量未读维护。此次修复通过物化 CTE 消除了回填时未读半连接产生的极慢执行计划。

## v2 协议

`POST /api/conversations/sync` 接收 `{ cursor: null | string, limit: 100 }`。返回 account_id、human_id、upserts、removed_ids、next_cursor、has_more、reset。

- 首次 cursor=null：按活动时间和 room_id keyset 读取摘要，保留初始账号水位。首批 reset=true，客户端替换旧缓存，后续批次合并。
- 快照结束后：从初始水位追增量，补齐分页期间移动到游标之前的房间，避免漏读。中间游标可持久化，刷新页面后继续。
- 增量：索引范围读取 `(user_id, version)`，单批最多 200 条变化，再去重并读取这些房间的**当前**摘要。旧事件不会重放已撤权数据；返回前重新检查当前成员关系。无变化请求不读消息表，也不列举全部房间。
- 每账号保留最近 10,000 条变化。过期水位或 epoch 变化自动 reset；错误账号或 malformed cursor 返回 400。游标不是权限凭证，所有查询始终由登录账号限定。
- 删除/撤权产生 tombstone；当其日志超过保留范围后清理。旧客户端会收到 reset 后重建，不依赖永久保存 tombstone。
- 本地实时消息与在途响应竞争时，保留本地较新摘要，并重放同一游标页；跳过 upsert 时不能提前推进游标。

旧 `{ known: { room_id: revision } }` 接口仍兼容，但同样只读持久化摘要；新版前端不再上传全部房间版本。

进入 Messages、回到前台和 Realtime 重连时同步；订阅 Human 和全部自有 Bot。30 秒目录轮询补偿丢失事件，打开房间仍保留既有 5 秒消息补偿。Realtime 是刷新提示，持久化游标负责恢复。

## 验证及可复现压测

```sh
cd backend
uv run pytest tests/ -q
CONVERSATION_TEST_DATABASE_URL=postgresql+asyncpg://... uv run pytest tests/test_conversation_cursor_postgres.py -q
CONVERSATION_TEST_DATABASE_URL=postgresql+asyncpg://... CONVERSATION_BENCHMARK=1 uv run pytest tests/test_conversation_cursor_postgres.py -q
```

PostgreSQL 测试为每个用例创建和删除独立 schema；只连接测试数据库。覆盖延迟提交不能被跳过、rollback、外部 SQL 恢复、outbox 删除与写入竞争、迁移重复执行、旧库回填及 epoch 重置。SQLite/API 测试覆盖消息去重、回执、未读、撤回、成员/所有权撤销、快照分页中房间前移、游标过期和账号隔离；直接检查无变化与少量变化同步不执行消息历史 SQL。

本地 PostgreSQL 16 Docker，100 房间、100,000 条历史消息，每场景 20 次、预热数据库缓存：

| 场景 | p50 | p95 | 每次消息历史查询 |
| --- | ---: | ---: | ---: |
| 完整重算摘要基线（使用已优化的同一聚合器） | 834.74ms | 844.09ms | 2 |
| 首次读取 100 个摘要 | 4.46ms | 5.75ms | 0 |
| 游标同步，无变化 | 1.30ms | 1.43ms | 0 |
| 游标同步，1 个房间变化 | 1.89ms | 2.09ms | 0 |

单房间新增消息及同步投影事务耗时一次采样 30.11ms。上述是 SQLAlchemy 服务层耗时，包含 session 打开/关闭，不含 HTTP、认证、网络和浏览器；不能当作生产 SLA。详细结果及 EXPLAIN 保存在 `docs/conversation-cursor-benchmark.json`。小数据集下 PostgreSQL 可以选择顺序扫描小型变更表，这不等于扫描消息历史。

前端验证：`cd frontend && pnpm vitest run`、`pnpm run build`。缓存 DOM 基准：`BOTCORD_CACHE_BENCHMARK=1 pnpm vitest run src/components/dashboard/conversation-cache.benchmark.test.tsx`。本次 1500ms 模拟 HTTP 延迟下缓存加载壳 DOM 在 47ms 出现；这是独立的 jsdom 测试，不是浏览器绘制耗时。

## 部署与运维

1. 先在目标数据库应用 `017_conversation_directory.sql`。迁移创建读取表、触发器，并将已有个人房间加入回填队列；不会在迁移内扫描消息历史。
2. 使用新版代码和目标后端配置执行 `uv run python scripts/backfill_conversations.py`，分批提交，可中断重跑。`--rebuild` 会重新排队所有个人房间及已有摘要，不重置 epoch，不改变未变化房间的版本。
3. 部署后端（包含同事务写入 hook 和恢复 worker），确认待处理队列已排空、代表账号的摘要正确，再部署新版前端。冷建库的 metadata.create_all 会安装同等捕获逻辑。
4. 监控 outbox 行数、投影异常日志、写事务耗时、同步 p95 和 reset 频率。普通 SQL 写入没有 ORM hook，但恢复 worker 会处理其队列；不能停掉全部恢复实例而继续依赖外部 SQL 更新。

回滚前端可继续使用旧 manifest 接口；回滚后端到旧聚合实现仍可读原始数据，触发器留下的队列可在恢复新版后继续处理。新实例仍在运行时不要删除读取表或触发器。本改动尚未部署到生产。
