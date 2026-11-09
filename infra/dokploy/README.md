# BotCord on Dokploy

后续测试部署统一使用指定 Dokploy `production` 环境；这是既有环境名，不代表生产发布
目标。frontend、Hub、Gateway 使用三个 Compose 资源，PostgreSQL 和 Redis 使用两个独立
Database 服务。现有 Preview Supabase 继续提供 Auth、Realtime、Storage 和应用数据库。

公开入口：

- frontend：`https://www.test.botcord.chat`
- Hub：`https://api.test.botcord.chat`
- 兼容入口：`https://preview.botcord.chat`，保留路径和查询参数并重定向到 frontend

只有 frontend 和 Hub 通过 HTTPS/Let's Encrypt 公开。Gateway、PostgreSQL 和 Redis
没有外部端口。production release、旧 EKS/Vercel 入口和本地 [`../compose/`](../compose/README.md)
拓扑不变。

## 资源拓扑

| 类型 | 资源 | ID | appName / 路径 | 用途 |
| --- | --- | --- | --- | --- |
| Database | `botcord-postgres` | `y4SAYkwmTWF-uYkB1Yn5s` | `botcord-postgres-native-5pmi4g` | 保留原 PostgreSQL 数据；不是当前 Hub 业务数据库 |
| Database | `botcord-redis` | `dM0yCFytwg_FAw0nXsEZ6` | `botcord-redis-native-ogq8mr` | Hub cache/pubsub，保留 AOF |
| Compose | `botcord-backend` | `Ug07R-0ic81Rm8uHA1SE6` | `infra/dokploy/botcord-backend.yml` | Hub，连接现有 Supabase DB 和独立 Redis |
| Compose | `botcord-gateway-ingress` | `4cHGyGZLYTEe7dTxtaFIe` | `infra/dokploy/botcord-gateway-ingress.yml` | 私有 setup/health 与持久 credentials |
| Compose | `botcord-frontend` | `amZUZW2R40fAmNop14Zbc` | `infra/dokploy/botcord-frontend.yml` | Web、BFF、Supabase Auth/Realtime client |

两个 Database 只连接内部 overlay `botcord-databases`，固定在包含原本地卷的 Swarm 节点，
各运行一个副本。它们复用以下原卷和挂载点：

- `botcord-data-rhhgnk_botcord_postgres_data` → `/var/lib/postgresql/data`
- `botcord-data-rhhgnk_botcord_redis_data` → `/data`

PostgreSQL 卷包含 97 张非系统表，但 Hub 的 `DATABASE_URL` 仍必须指向现有 Supabase。
Redis 使用原密码并启用 AOF。禁止发布 Database host port，禁止改变卷名、挂载点、固定
节点或镜像摘要后绕过 CI 身份校验。

旧 `botcord-data` Compose 资源已使用 `deleteVolumes=false` 删除，API 读回为 404；两个
原卷仍由健康的 Database 服务挂载。旧 manifest 和变量示例仅保存在
[`rollback/`](rollback/)，用于必要时重建资源，不再是常规部署资源。

## 数据库拆分验收

冷切换已完成并验证：

- PostgreSQL 和 Redis 各有一个 healthy writer、零重启、无 host port，只连接私有
  `botcord-databases`，并固定在包含原卷的节点。
- 两个服务的运行时 imageID 与拆分前相同，挂载源和目标保持不变。
- PostgreSQL 仍有 97 张非系统表；逻辑 `pg_dump` SHA256 和
  `pg_control_system` identifier 在切换前后相同。
- Redis 认证 `PING` 成功，AOF 仍启用，key count 在切换前后均为 0。
- root-only 冷备份和受保护的回滚元数据存于远端
  `/var/backups/botcord-native-db-20261109`；文档和日志不记录其中的 secrets。
- Hub 只修改了 Redis 主机和数据库网络。Supabase `DATABASE_URL` 及其他环境变量保持
  原值，Hub、API 和 frontend 均恢复 healthy/HTTP 200。

切换时没有保留空 Raw tombstone：Dokploy UI 仍可能从旧工作区重新启动它，造成同卷双写。
因此在新 Database 验收通过后，旧 Compose 才被完整退役；删除时明确保留了 volumes。

回滚必须反向保持单写：停止 Hub → 停止两个 Database → 确认任务为零 → 使用受保护的
元数据和仓库 manifest 重建旧 Compose（保留原 appName 和卷）→ 启动旧 data → 恢复 Hub
的原 Redis 地址。如需恢复 CI 部署，还要将新 Compose ID 加回 member 权限。不要使用
`freshVolumes`、`down -v` 或任何卷清理命令。

## 测试发布流程

- `ci.yml`：PR 只运行检查；`main` push 在测试通过后调用 `deploy-dokploy-test.yml`。
- `deploy-dokploy-test.yml`：构建三份 ARM64 不可变应用镜像。控制脚本先只读校验两个
  Database 的精确身份和 `running/healthy` 任务，再依次发布 Hub、Gateway、frontend。
- CI 不部署、重启或修改 PostgreSQL/Redis，也不再更新旧 `botcord-data`。
- 原 `deploy-pr-backend-preview.yml` 手工入口发布整个 Dokploy 测试应用栈，不执行共享
  数据库迁移。
- production `release.yml` 保持原路径；旧 deploy reusable 仅接受 `prod`。
- Vercel Git Preview 构建由 `frontend/vercel.json` 跳过；Production 构建保留。
- ECR 登录沿用现有自动刷新机制，不保存 12 小时登录凭证或增加重复续期任务。

CI member 的权限范围已收敛为五个资源：三个应用 Compose 加两个 Database；已删除的旧
data Compose 不在范围内。真实 CI token 探测已验证旧 ID 返回 401，五个目标资源均返回
200（[workflow run 42564767086](https://github.com/botlearn-ai/botcord/actions/runs/42564767086)）。
控制脚本通过资源读取权限和现有 service-read 能力完成检查，不授予全局
Docker、删除服务、SSH 或 Traefik 权限，也不使用或输出 Database 环境变量。

GitHub variables：`DOKPLOY_URL`、`BOTCORD_TEST_SUPABASE_URL`、
`BOTCORD_TEST_SUPABASE_ANON_KEY`；secrets：`DOKPLOY_AUTH_TOKEN` 和既有 ECR 配置。
真实 runtime secrets 只存于 Dokploy。不要输出完整资源对象或把 Supabase service-role、
数据库密码、Redis 密码、签名私钥放进 CI 日志或 frontend build args。

目标 ref 只决定镜像源码。控制脚本从所选 workflow 的固定 `github.workflow_sha` 检出至
独立 `.deployment-control`；手工触发时只选择受信 workflow 版本。CI 将 Compose source
固定为 `dokploy-test-<完整 commit SHA>` tag，并保持 Auto Deploy 关闭。

## 环境配置

1. Compose Provider 使用 GitHub：`botlearn-ai/botcord`、`DokployForBotLearn`。
2. 按各自 `.env.example` 将变量注入对应 Compose，不共享整份 secrets。
3. Backend 和 frontend 使用同一个现有 Supabase 项目；Backend 保持 schema auto-create
   和周期后台任务关闭。
4. Backend 同时连接现有 `botcord-production` 与私有 `botcord-databases` 网络；frontend
   和 Gateway 不连接数据库网络。
5. Gateway setup `9101` 只供内部调用，不创建公网 Domain。

`deploy.py` 先校验实例、资源身份、Provider、仓库、Compose Path 和两个 Database 的只读
运行态，再更新三个应用镜像和 source tag。每个应用完成 deployment 与容器健康读回后才
继续。多资源发布不是原子事务；失败时按上一次 tag/镜像 digest 逐个回退，不删除卷。

## 镜像和访问诊断

目标主机为 `linux/arm64`。Backend、Gateway 与 frontend 使用唯一 tag，部署时固定
registry digest，不覆盖已有 `preview`/`prod` runtime tag。frontend 的公开 URL、
Supabase URL 或 anon key 变化后必须重建镜像；服务端 secrets 均为 runtime-only。

```bash
python3 infra/dokploy/tunnel.py
# 保持进程运行：
# frontend http://localhost:28080
# Hub      http://localhost:28000

dokploy compose one --composeId '<id>' --json
dokploy postgres one --postgresId 'y4SAYkwmTWF-uYkB1Yn5s' --json
dokploy redis one --redisId 'dM0yCFytwg_FAw0nXsEZ6' --json
```

隧道只用于运维诊断，关闭脚本不会停止远端服务。不要将命令返回的完整资源对象复制到
日志或文档，因为其中可能包含环境变量。

## 验收边界

两个 Database 的运行态、数据连续性、单写边界和 Hub/API/frontend 已完成切换验收。
PR [#1131](https://github.com/botlearn-ai/botcord/pull/1131) 已合并，51 个 infra tests、checks
和 review 均通过。首次合并后的 [main 自动部署](https://github.com/botlearn-ai/botcord/actions/runs/42565649067)
成功；两个 Database 的容器身份和 StartedAt 均未变化，确认应用 CI 没有重启数据库。
既有入口的登录、Dashboard、Messages、BFF、静态资源和 Realtime 证据保留在
[`DEPLOYMENT.md`](DEPLOYMENT.md)。

仍未验收实际 Agent 推理闭环、Google/GitHub 账号授权、Stripe/支付、Resend/邮件和其他
付费集成。测试入口仍是固定新增 Hub 的单 Hub canary，不代表两个 Hub active-active。
