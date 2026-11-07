# BotCord on Dokploy

后续测试部署统一使用指定 Dokploy `production` 环境；保留这个既有环境名，不代表生产发布目标。它包含 frontend、Hub、
Gateway、PostgreSQL 和 Redis 五个容器，但复用既有 Preview Supabase 的 Auth、Realtime、
Storage 和应用数据库。环境名称不代表数据已与 Preview 隔离。

公开入口：

- frontend：`https://www.test.botcord.chat`
- Hub：`https://api.test.botcord.chat`

两个域名均解析到 Dokploy 主机；仅 frontend 和 Hub 通过 HTTPS/Let's Encrypt 公开，
不发布 host port。Gateway、PostgreSQL 和 Redis 保持私有，不修改旧 EKS/Vercel 入口。

> **仅限单 Hub canary：**新入口只供固定连接新增 Hub 的新建/QA Agent 使用。不要操作仍
> 回调旧 Hub 的既有 Agent，不要称为 active-active，也不要声称 owner-chat/status/实时
> fanout 已跨新旧 Hub 闭环。本轮没有实际执行 Agent 推理闭环。

## Compose 资源与部署顺序

| Compose Path | 容器 | 用途 |
| --- | --- | --- |
| `dependencies.yml` | PostgreSQL 16、Redis 7 | PostgreSQL 保留但当前不用；Redis 供新增 Hub 使用 |
| `botcord-backend.yml` | Hub | 连接现有 Supabase DB；关闭 schema auto-create 与周期任务 |
| `botcord-gateway-ingress.yml` | Gateway Ingress | 私有 setup/health 与持久 credentials |
| `botcord-frontend.yml` | Next.js standalone | Web、BFF、Supabase Auth/Realtime client |

顺序为 data → backend → gateway → frontend。CI 每步读回 deployment `done` 和预期
容器集合 `running/healthy` 后再继续；实际 imageID、重启次数、网络和 mounts 另由管理员
SSH 验收，服务账号不授予全局 Docker 权限。Gateway setup `9101` 仅供专用
网络内部调用，不创建公网 Domain。

## 环境配置

1. 用 Dokploy CLI 核对目标 project/environment，创建或复用专用网络
   `botcord-production`。
2. 每个 manifest 对应一个独立 Compose 资源，Provider 使用 GitHub：
   `botlearn-ai/botcord`、`DokployForBotLearn`，Compose Path 对应上表。
   CI 将 source 固定为 `dokploy-test-<完整 commit SHA>` tag；关闭 Dokploy Auto Deploy，
   避免 GitHub push 在测试和镜像构建完成前触发部署。
3. 分别参考 `dependencies.env.example`、`botcord-backend.env.example`、
   `botcord-gateway-ingress.env.example` 和 `botcord-frontend.env.example`，只向每个资源
   注入其拥有的变量，不共享整份 secrets。
4. Backend 和 frontend 的数据库变量必须指向同一个现有 Supabase 应用数据库；
   frontend 的 public/server Supabase URL 必须属于同一项目。
5. 当前实例使用 Supabase JWKS 验签；Backend 必须配置同一项目的 JWKS、service-role、
   Storage bucket 与 `FILE_STORAGE_BACKEND=supabase`。这些值只属于 server runtime。
6. Backend 关闭 schema auto-create 和周期任务，由旧 Preview 部署继续持有所有权。
7. 保留独立 PostgreSQL、Redis、uploads、Gateway `/data` 与 `/secrets` 卷。当前独立
   PostgreSQL 不承载业务，不能删除或称作业务数据迁移完成。
8. 新 Hub 使用独立 Redis；已读回 `PING` 且有一个订阅连接。旧 Preview Redis 是
   `us-east-1` 私网 ElastiCache，香港主机当前不可达，本次不改造它。即使将来共用
   Redis，进程本地 trace 仍是已知缺口，因此不能据此推断 owner-chat/status 跨 Hub
   一致。

所有真实 secrets 只存放于 Dokploy Environment。不要输出 `compose one` 的完整 env，
不要把 Supabase service-role、数据库密码或签名私钥放入 frontend build args。

## 测试发布流程

- `ci.yml`：PR 只运行检查；`main` push 在测试通过后调用 `deploy-dokploy-test.yml`。
- `deploy-dokploy-test.yml`：支持手动部署指定 ref，构建三份 ARM64 不可变镜像，
  再按 data → Hub → Gateway → frontend 发布同一提交的 GitHub Compose 配置。
- 原 `deploy-pr-backend-preview.yml` 手工入口改为发布整个 Dokploy 测试环境，
  不再发布旧主机/Vercel Preview，也不执行共享数据库迁移。
- 生产 `release.yml` 保持原有路径；旧三个 deploy reusable 仅接受 `prod`。
- Vercel Git 集成的 Preview 构建由 `frontend/vercel.json` 跳过；Production 构建与
  `vercel deploy --prebuilt --prod` 保留。
- GitHub variables：`DOKPLOY_URL`、`BOTCORD_TEST_SUPABASE_URL`、
  `BOTCORD_TEST_SUPABASE_ANON_KEY`；secret：`DOKPLOY_AUTH_TOKEN`，镜像沿用 `ECR_REGISTRY`。
- 应用 runtime secrets 仍只在 Dokploy；GitHub 的 Supabase URL/anon key 只供公开 bundle 构建。
- CI API key 属于独立 member，只开放这四个 Compose；不授予删除或全局 Docker 权限。
  当前 key 到期日为 2027-11-06，限流 300 次/分钟；到期前更新 GitHub secret 并撤销旧 key。
- ECR 登录沿用已有自动刷新机制，不保存长期硬编码的 ECR 登录 token，也不增加重复续期任务。

目标 ref 只用于镜像源码构建。控制脚本从所选 workflow 的固定 `github.workflow_sha`
检出至独立 `.deployment-control`；手工触发时应选择受信 workflow 版本，不能将任意 PR
作为控制代码。初次上线由维护者显式选择已审查的任务分支；合并后默认选 `main`。

`deploy.py` 先校验实例、资源身份、GitHub Provider、仓库与 Compose Path，再更新镜像变量
和 source tag。每个资源完成 deployment 与容器健康读回后才继续，最后检查两个 HTTPS
入口。失败停止后续资源；多资源发布不是原子事务，按上一次 tag/镜像 digest 逐个回退，
不删除卷。首次 Raw → GitHub 的迁入需要显式 `--adopt-provider`；常规 CI 不允许隐式迁入。

本次只改测试发布目的地，不关停旧部署、不切换旧域名、不转移既有 Agent，也不接管旧 Hub
的周期任务。共享数据库的 schema 变更仍需单独评估和执行，不能靠 Hub 自动建表替代迁移。

## 镜像构建

目标主机为 `linux/arm64`。Backend、Gateway 与 frontend 使用唯一 tag，部署时固定
registry digest，不覆盖已有 `preview`/`prod` runtime tag。

```bash
docker build --provenance=false -f backend/Dockerfile \
  -t "$BOTCORD_BACKEND_IMAGE" backend

docker build --provenance=false -f packages/gateway-ingress/Dockerfile \
  -t "$BOTCORD_GATEWAY_INGRESS_IMAGE" .

docker build --provenance=false -f frontend/Dockerfile \
  --build-arg NEXT_PUBLIC_APP_URL="$NEXT_PUBLIC_APP_URL" \
  --build-arg NEXT_PUBLIC_HUB_BASE_URL="$NEXT_PUBLIC_HUB_BASE_URL" \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -t "$BOTCORD_FRONTEND_IMAGE" frontend
```

这些 frontend 参数是浏览器公开配置；服务端 Supabase URL、DB URL、service-role、
Stripe、绑定签名等均为 runtime-only。公开 URL 或 anon key 变化后必须重建 frontend。

## 访问与读回

```bash
python3 infra/dokploy/tunnel.py
# 保持进程运行：
# frontend http://localhost:28080
# Hub      http://localhost:28000

dokploy compose one --composeId '<id>' --json
dokploy deployment all-by-compose --composeId '<id>' --json
dokploy docker get-containers --json
```

隧道脚本根据当前容器读取 IP，经 `botlearn-test-hk` SSH/SSM 转发到本机；关闭脚本只关闭
隧道，不停止远端服务，只用于运维诊断。远端 frontend 镜像以内嵌的公开 APP/Hub URL
构建。frontend 与 Hub 各自接入 Compose default、`botcord-production` 和
`dokploy-network`；其余服务只接入 `botcord-production`。Traefik 明确使用
`dokploy-network`。

## 验收与限制

两个 Domain deployment 已完成：HTTPS 有效，HTTP 均以 301 跳转 HTTPS，Hub health 为
200，精确 frontend Origin 的 CORS 为 200。frontend Let's Encrypt 证书有效期为
2026-11-06 至 2027-02-04。fresh browser 已验证匿名登录边界、邮箱密码登录、Dashboard、
Messages、带 cookie BFF 200、无 cookie 401 和 21 个静态资源。57 个登录态请求（含 12 个
API）均低于 400，page errors、Analytics 和 localhost 请求均为零。auth callback 返回
公开域名；Supabase redirect allowlist 保留原值并加入新前端 origin 与通配路径。

Realtime QA 已成功订阅；Realtime SDK 的 client `send` 返回 error，随后 service-role
定向 admin broadcast 被接受并由该客户端收到。两条路径必须如实区分。

未验证：实际 Agent 推理闭环、Google/GitHub 账号授权、Stripe/支付、Resend/邮件和其他
付费集成。
Gateway 仅完成健康与鉴权边界检查；独立 Redis 与旧 Hub 的跨部署 fanout 尚待核查。
该部署只能作为固定新增 Hub 的单 Hub canary；既有 Agent 切换、跨 Hub owner-chat/status
和实际 Agent 推理闭环均未验收。

当前资源 ID、镜像 digest 和时间点快照见 [DEPLOYMENT.md](DEPLOYMENT.md)。
