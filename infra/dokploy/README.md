# BotCord on Dokploy

测试部署使用指定 Dokploy `production` 环境；这是既有环境名，不代表生产发布目标。
frontend、Hub、Gateway 使用三个 Compose 资源，Redis 使用一个独立 Database 服务。
Preview Supabase 继续提供 Auth、Realtime、Storage 和应用数据库。

公开入口：

- frontend：`https://www.test.botcord.chat`
- Hub：`https://api.test.botcord.chat`
- 兼容入口：`https://preview.botcord.chat`，保留路径和查询参数并重定向到 frontend

只有 frontend 和 Hub 通过 HTTPS/Let's Encrypt 公开。Gateway 和 Redis 没有外部端口。
production release、旧 EKS/Vercel 入口和本地 [`../compose/`](../compose/README.md) 拓扑不变。

## 当前资源拓扑

| 类型 | 资源 | ID | appName / 路径 | 用途 |
| --- | --- | --- | --- | --- |
| Database | `botcord-redis` | `dM0yCFytwg_FAw0nXsEZ6` | `botcord-redis-native-ogq8mr` | Hub cache/pubsub，保留 AOF |
| Compose | `botcord-backend` | `Ug07R-0ic81Rm8uHA1SE6` | `infra/dokploy/botcord-backend.yml` | Hub，连接现有 Supabase DB 和独立 Redis |
| Compose | `botcord-gateway-ingress` | `4cHGyGZLYTEe7dTxtaFIe` | `infra/dokploy/botcord-gateway-ingress.yml` | 私有 setup/health 与持久 credentials |
| Compose | `botcord-frontend` | `amZUZW2R40fAmNop14Zbc` | `infra/dokploy/botcord-frontend.yml` | Web、BFF、Supabase Auth/Realtime client |

Redis 只连接内部 overlay `botcord-databases`，固定在包含原卷的 Swarm 节点并运行一个
副本。它复用 `botcord-data-rhhgnk_botcord_redis_data` → `/data`，使用原密码并启用 AOF。
禁止发布 host port，禁止改变卷名、挂载点、固定节点或镜像摘要后绕过 CI 身份校验。

独立 PostgreSQL 不承载 Hub 或 frontend 业务数据，已从当前拓扑和 CI 发布前置条件中
退役。Hub 的 `DATABASE_URL` 必须继续指向现有 Supabase。历史卷、冷切换和数据连续性
证据见 [`DEPLOYMENT.md`](DEPLOYMENT.md)；[`rollback/`](rollback/) 只作归档/灾难恢复
参考，不是常规部署资源。本地 Compose PostgreSQL 不受此次远端清理影响。

## 测试发布流程

- `ci.yml`：PR 只运行检查；`main` push 在测试通过后调用 `deploy-dokploy-test.yml`。
- `deploy-dokploy-test.yml`：构建三份 ARM64 不可变应用镜像。控制脚本先只读校验 Redis
  的精确身份和 `running/healthy` 任务，再依次发布 Hub、Gateway、frontend。
- CI 不部署、重启或修改 Redis，也不更新已退役的数据库资源。
- 原 `deploy-pr-backend-preview.yml` 手工入口发布整个 Dokploy 测试应用栈，不执行共享
  数据库迁移。
- production 前端使用 [EKS Release 链路](../eks/README.md)；deploy reusable 仅接受 `prod`。
- Vercel Git 自动部署已由 `frontend/vercel.json` 关闭；保留现有部署与手工 CLI 回滚。

当前部署控制只需要读取三个应用 Compose 和 Redis。CI member 的实际权限应同步移除已
退役 PostgreSQL；权限读回属于平台配置验收，不由仓库代码隐式完成。控制脚本不需要
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

`deploy.py` 先校验实例、资源身份、Provider、仓库、Compose Path 和 Redis 的只读运行态，
再更新三个应用镜像和 source tag。每个应用完成 deployment 与容器健康读回后才继续。
多资源发布不是原子事务；失败时按上一次 tag/镜像 digest 逐个回退，不删除卷。

## 镜像和访问诊断

目标主机为 `linux/arm64`。Backend、Gateway 与 frontend 使用唯一 tag，部署时固定 registry
digest，不覆盖已有 `preview`/`prod` runtime tag。frontend 的公开 URL、Supabase URL 或
anon key 变化后必须重建镜像；服务端 secrets 均为 runtime-only。

```bash
python3 infra/dokploy/tunnel.py
# 保持进程运行：
# frontend http://localhost:28080
# Hub      http://localhost:28000

dokploy compose one --composeId '<id>' --json
dokploy redis one --redisId 'dM0yCFytwg_FAw0nXsEZ6' --json
```

隧道只用于运维诊断，关闭脚本不会停止远端服务。不要将命令返回的完整资源对象复制到
日志或文档，因为其中可能包含环境变量。

## 验收边界

当前发布闭环覆盖三个应用 Compose、Redis、公开 health 和容器健康。数据库拆分与历史
验收记录保留在 [`DEPLOYMENT.md`](DEPLOYMENT.md)。仍未验收实际 Agent 推理闭环、
Google/GitHub 账号授权、Stripe/支付、Resend/邮件和其他付费集成。测试入口仍是固定新增
Hub 的单 Hub canary，不代表两个 Hub active-active。
