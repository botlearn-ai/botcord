# Messages 缓存与游标同步

## 用户体验

Supabase 恢复账号后，按 Hub 环境和账号 ID 同步读取本地会话摘要、分组、Bot 筛选和同步游标。鉴权初始化期间加载壳展示不可交互的缓存列表；鉴权完成后切换到正常列表。首次无缓存时读取最新 100 个摘要，再分页补齐。旧 Human 成员接口只在身份初始化完成后后台加载，不阻塞首屏。

缓存与消息历史分开，不保存 token，也不授予接口权限。退出登录清除当前账号的目录缓存；切换账号隔离数据和进行中请求。网络失败保留列表。旧缓存没有游标时仍可先显示，再通过新快照替换。

目录按最后有效 message/system 时间倒序，同时间以房间 ID 稳定排序，无消息房间置后；渲染层继续支持置顶和隐藏水位。时间、作者、预览统一来自摘要，typing、ack、result、error、状态回执不更新活动时间。撤回更新预览但不抬高时间。多个自有 Bot 共处一个房间时保留全部来源。

## 持久化读取模型

读取模型和逻辑消息投影将列表读取、常规写入与历史消息聚合分离。PostgreSQL 启用 RLS 且不开放客户端策略，避免通过 Supabase 表接口绕过 Hub 读取私有摘要；Hub 数据库角色须为表所有者或具备 BYPASSRLS：

| 表 | 用途 |
| --- | --- |
| conversation_dirty_rooms | 同事务合并待更新房间的 outbox；reasons 合并资料/消息/已读/重建，generation 获取写锁，writer_xid 标识本次写事务 |
| conversation_dirty_messages / conversation_dirty_readers | 按逻辑消息 ID、阅读主体合并变化；先锁房间再记录明细 |
| conversation_messages | 每个 `(room_id, msg_id)` 一条精简逻辑消息，保留最小有效投递 ID 的既有语义 |
| conversation_room_summaries | 每房间一份最新消息时间、发送者和预览 |
| conversation_accounts | 每账号 epoch、版本和保留日志下界 |
| conversation_entries | 每账号/房间的当前摘要、活动时间、未读、权限、来源和删除标记 |
| conversation_changes | 每账号按提交顺序分配的版本及变化房间 ID |

数据库触发器捕获 rooms、room_members、有效 message_records 及 Agent/User 身份、名称、头像的相关变化，覆盖 ORM、批量 SQL 和外部脚本。成员删除、房间删除、Bot 所有权转移也会捕获；投递/响应状态更新不触发消息摘要重建。名称/头像变化也会更新其作为成员或最后发送者出现的摘要。

正常 Hub AsyncSession 写入在最外层 before_commit 中刷新本事务影响房间的摘要、追加变化，再与原始写入一起提交；逐接收者 savepoint 的提交不执行投影，不接管其它房间的积压回填。writer_xid 仅用于筛选本事务的 outbox 行，不作为同步游标；投影异常禁止提交，调用方必须 rollback 后重试。直接 SQL 或超过同步批次 500 房间的导入通过后台恢复任务补齐：后台每批最多 20 房间，空闲每秒检查，满批间隔 100ms，失败指数退避至 30 秒。outbox 删除和投影在同一事务中，崩溃会回滚并保留重试依据。数据库触发器不依赖进程内标记。

投影器使用 FOR UPDATE SKIP LOCKED 领取房间，然后按稳定账号顺序锁住 conversation_accounts 再递增版本。后一个版本不能早于前一个版本提交，避免使用全局自增序号当游标时的乱序提交漏读。并发写入遇到正在处理的 outbox 行会等待并重新更新/插入，不会被旧任务删除。重放不变摘要不追加版本。

**成本边界：**常规同步读取不访问 message_records。常规消息写入只按变更的 `(room_id,msg_id)` 索引定位 canonical 投递，精简投影变化前后做未读差分；共享房间摘要按倒序索引取一条，只准备一次。重复投递不重复计数。已读只处理该 Human 对应账号：读到最新直接归零，部分阅读只统计跨过的精简消息区间。资料更新不扫描消息历史。首次加入、阅读水位被直接 SQL 向后修改等情况可能统计精简投影；首次初始化/显式重建才分批读取原始历史。群成员扇出仍是 O(账号数)，不宣称所有写入 O(1)。

未读保留原语义：同一逻辑消息只算一次，排除自己的消息、回执、已撤回消息，遵守成员 last_viewed_at。撤回最新消息保留活动时间并显示撤回占位；删除 canonical 副本会按该逻辑 ID 重新选择有效副本。账号版本和原数据同事务更新，重放不会重复加减。此次不改变阅读水位 HTTP 协议。


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

以下为迁移 017 的历史读取基准，不能代表迁移 018 的写入性能。本地 PostgreSQL 16 Docker，100 房间、100,000 条历史消息，每场景 20 次、预热数据库缓存：

| 场景 | p50 | p95 | 每次消息历史查询 |
| --- | ---: | ---: | ---: |
| 旧版完整重算摘要基线（迁移 017 时测量） | 834.74ms | 844.09ms | 2 |
| 首次读取 100 个摘要 | 4.46ms | 5.75ms | 0 |
| 游标同步，无变化 | 1.30ms | 1.43ms | 0 |
| 游标同步，1 个房间变化 | 1.89ms | 2.09ms | 0 |

单房间新增消息及同步投影事务耗时一次采样 30.11ms。上述是 SQLAlchemy 服务层耗时，包含 session 打开/关闭，不含 HTTP、认证、网络和浏览器；不能当作生产 SLA。详细结果及 EXPLAIN 保存在 `docs/conversation-cursor-benchmark.json`。小数据集下 PostgreSQL 可以选择顺序扫描小型变更表，这不等于扫描消息历史。

前端验证：`cd frontend && pnpm vitest run`、`pnpm run build`。缓存 DOM 基准：`BOTCORD_CACHE_BENCHMARK=1 pnpm vitest run src/components/dashboard/conversation-cache.benchmark.test.tsx`。本次 1500ms 模拟 HTTP 延迟下缓存加载壳 DOM 在 47ms 出现；这是独立的 jsdom 测试，不是浏览器绘制耗时。

## 迁移 018 部署与运维

这是捕获函数与投影模型的联合变更，旧 Hub 与新捕获函数不能混跑。通过已评审迁移和部署流程执行；以下顺序需先在 preview 验证：

1. 停止目标环境的旧 Hub 写入和恢复 worker，安排维护窗口。确认当前目标 schema，备份并保留旧版本镜像。不要直接在生产运行本地性能测试。
2. 在已有 017 的数据库应用 `018_incremental_conversation_projection.sql`。迁移添加精简表和列、RLS、替换触发器，并排队个人房间；迁移事务内不扫描历史。DDL 锁超时 5 秒、语句超时 60 秒，失败整体回滚。
3. 用新版代码执行 `uv run python scripts/repair_conversation_capture.py --check`，然后 `uv run python scripts/backfill_conversations.py --batch-size 1 --pause 0.1`。默认每事务一个房间，原始消息每批最多取 500 个 canonical 记录，单条 SQL 超时 60 秒。可中断重跑；失败保留队列，先排查再重试。超大单房间仍需实测回填耗时，不把批量取数误认为整房间事务耗时有固定上限。
4. 确认待处理房间及消息/阅读明细队列排空、个人房间均有共享摘要，核对代表账号的最新预览、未读、Bot 来源和撤回占位。未变化摘要不递增账号版本或重置 epoch。`--rebuild` 可显式重建并修复全部个人房间。
5. 部署新版 Hub 后恢复流量，监控 outbox 积压、投影异常、写事务延迟、Supabase 临时文件增量和磁盘等待。现有前端、v2 游标和 manifest 接口继续使用。

美国 preview/prod 的 `Deploy Backend` 现已自动执行以上维护步骤。先构建并推送按源码 SHA 命名的候选镜像，固定 digest；运行标签在回填成功后才推广。发布入口保持不变：先运行 `Deploy PR Backend Preview`（`run_migrations=false`），验证后再运行 `Release`（`targets=backend`、`run_migrations=false`）。迁移 018 由后端发布门禁自动处理；通用 SQL 迁移器拒绝在没有维护协调的情况下执行它。

发布器核对 `/www/devops` 已同步当前 main 且目标配置无漂移，从正在运行的 Hub 读取必要数据库配置，校验已有迁移 017。首次升级停止精确的 preview 服务或美国 `prod/botcord-backend`，保存 15 组捕获函数/触发器定义，事务性应用 018 和 ledger，逐房间回填，核对队列清空、共享摘要完整、epoch 保留，再启动候选镜像。生产 HPA 的 minReplicas 必须大于零，以允许手动缩为零进入维护模式。已验证安装 018 后的日常版本不重复停机迁移。

Preview 存在旧 Hub 已创建 017 结构、账本仍停留在 016 的历史情况。发布器会先使用实际旧镜像只读验证捕获函数、触发器和 RLS；确认兼容后，在停写窗口先正式执行 017 并记录账本，再执行 018。不会仅凭表名补写迁移记录。恢复时也还原 017 原先是否记录的状态。

如果迁移、回填或运行时健康检查失败，发布器停止候选版本，恢复原捕获定义和迁移记录，用保留的旧镜像回填后恢复原运行标签。恢复失败会保持工作流失败并保留 runner 上的 `botcord-release-*/capture.json`；文件只包含 DDL 和聚合校验，不含数据库凭据或消息正文。候选和旧镜像均在维护前就绪；最终验收检查实际容器/Pod 镜像和进程内 `/health`。取消或超时后的运行状态仍需操作员确认，不能把工作流取消视为恢复成功。

回滚必须停止新版写入/worker，再用旧版 `repair_conversation_capture.py --apply` 恢复旧捕获函数并排队、回填旧摘要后恢复旧 Hub；不要只回滚镜像让旧启动校验面对新函数。保留新增表/列，恢复新版前重跑迁移 018 和新版回填，防止停用期间的精简投影漂移。不要在服务运行时删除投影表。

写入性能验证使用独立、可丢弃 PostgreSQL，测试会创建并删除自己生成的 schema：

```sh
cd backend
CONVERSATION_TEST_DATABASE_URL=postgresql+asyncpg://... uv run pytest tests/test_conversation_incremental_postgres.py -q
CONVERSATION_TEST_DATABASE_URL=postgresql+asyncpg://... CONVERSATION_WRITE_BENCHMARK=1 uv run pytest tests/test_conversation_incremental_postgres.py -q
```

基准分别生成单房间 1,000 / 100,000 条历史消息，测量 10 接收者消息发送和标记已读；断言每次发送只查询一个逻辑消息 ID，读到最新不查询消息表，点查与最新消息索引查询无临时文件且读取块数有界。结果默认输出 `/tmp/botcord-conversation-write-benchmark.json`；服务层、热缓存数据不能作为生产 SLA。

本次 PostgreSQL 17 本地热缓存结果（5 次发送，10 个接收者）：

| 单房间历史 | 发送中位耗时 | 标记全部已读（单次） | 原始消息点查/发送 | 点查命中块数 | 临时写块 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 16.12 ms | 18.66 ms | 1 | 3 | 0 |
| 100,000 | 17.06 ms | 8.56 ms | 1 | 4 | 0 |

原始结果与执行计划见 [conversation-write-benchmark.json](conversation-write-benchmark.json)。这是结构性验证：历史扩大 100 倍后仍走有界点查；小样本耗时波动不用于推导加速倍数。
