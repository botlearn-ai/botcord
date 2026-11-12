# BotCord infrastructure

本目录覆盖 BotCord 的常驻服务闭环：Next.js frontend、Hub、Gateway Ingress、
Redis，以及仅供本地开发使用的 PostgreSQL。CLI、daemon 与 desktop 是客户端或按需进程，
不作为常驻容器。

- [`compose/`](compose/README.md)：本地源码构建；frontend `18080`、Hub `18000`、
  Gateway health `19100` 均只绑定 loopback。本地 Compose 拓扑不随远端数据库拆分变化。
- [`dokploy/`](dokploy/README.md)：测试环境的 frontend、Hub、Gateway 使用 Compose；
  Redis 使用独立 Dokploy Database 服务。仅 frontend 与 Hub 公开。
- [`dokploy/DEPLOYMENT.md`](dokploy/DEPLOYMENT.md)：当前资源、迁移状态、历史验收证据和
  未覆盖边界。
- [`eks/`](eks/README.md)：production frontend 的美国区 EKS 两阶段交付控制器；候选
  镜像必须先经 aibrary-devops 清单评审，发布只应用已同步的不可变 digest。

```bash
pnpm compose:up
pnpm compose:ps
pnpm compose:logs
pnpm compose:down # 保留数据、uploads 与 Gateway secrets
pnpm infra:check
```

## 数据边界

**不部署新的 Supabase。**Dokploy 的 frontend/Hub 继续使用现有 Preview Supabase 项目的
Auth、Realtime、Storage 和应用数据库。Supabase service-role、JWKS 和 Storage 配置仍
仅属于服务端。`infra/compose` 中的 PostgreSQL 只属于本地开发拓扑。

远端独立 PostgreSQL 不承载业务流量，已从当前测试拓扑和发布前置检查中退役。Redis
继续复用原 AOF 卷和密码，供测试环境 Hub 使用。2026-11-09 的数据库拆分、卷连续性和
冷备份证据保留在 [`dokploy/DEPLOYMENT.md`](dokploy/DEPLOYMENT.md)，不代表 PostgreSQL
仍是当前服务。旧配置只作为历史归档，禁止把它当作常规部署入口。

测试入口为 `https://www.test.botcord.chat` 和 `https://api.test.botcord.chat`。
`https://preview.botcord.chat` 是唯一的旧域名例外：它保留路径和查询参数，重定向到
`https://www.test.botcord.chat`。测试环境既有 Dokploy 入口不变。production frontend
从 Vercel 迁往美国区 EKS；迁移期间保留 Vercel 作为回滚入口，DNS 切换是独立操作。

> **Canary 边界：**测试入口只用于固定连接新增 Hub 的新建/QA Agent。共享 Supabase
> 不会自动补齐两个 Hub 之间的 owner-chat、status 或实时 fanout；本轮也未验收实际
> Agent 推理闭环。
