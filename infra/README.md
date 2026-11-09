# BotCord infrastructure

本目录覆盖 BotCord 的常驻服务闭环：Next.js frontend、Hub、Gateway Ingress、
PostgreSQL 和 Redis。CLI、daemon 与 desktop 是客户端或按需进程，不作为常驻容器。

- [`compose/`](compose/README.md)：本地源码构建；frontend `18080`、Hub `18000`、
  Gateway health `19100` 均只绑定 loopback。本地 Compose 拓扑不随远端数据库拆分变化。
- [`dokploy/`](dokploy/README.md)：测试环境的 frontend、Hub、Gateway 使用 Compose；
  PostgreSQL 和 Redis 使用两个独立的 Dokploy Database 服务。仅 frontend 与 Hub 公开。
- [`dokploy/DEPLOYMENT.md`](dokploy/DEPLOYMENT.md)：当前资源、迁移状态、历史验收证据和
  未覆盖边界。

```bash
pnpm compose:up
pnpm compose:ps
pnpm compose:logs
pnpm compose:down # 保留数据、uploads 与 Gateway secrets
pnpm infra:check
```

## 数据边界

**不部署新的 Supabase。**本地和 Dokploy 的 frontend/Hub 继续使用现有 Preview Supabase
项目的 Auth、Realtime、Storage 和应用数据库。Hub 的 `DATABASE_URL` 不改为 Dokploy
PostgreSQL；Supabase service-role、JWKS 和 Storage 配置仍仅属于服务端。

远端 PostgreSQL 与 Redis 已从一个 `botcord-data` Compose 拆为两个 Dokploy Database
服务。两个服务复用原持久卷，没有创建空卷：

- PostgreSQL 原卷包含 97 张非系统表，但它不是当前 Hub 的业务数据库；保留数据不等于
  将业务数据库从 Supabase 迁入 PostgreSQL。
- Redis 保留原 AOF 数据和密码，并继续供测试环境 Hub 使用。

切换已按单写顺序完成：先停止 Hub 和旧 data 容器，确认卷没有使用者并完成 root-only
冷备份，再启动两个 Database。旧 `botcord-data` 资源已在保留卷的前提下删除；当前只有
两个 Database 挂载原卷。回滚仍必须先停止 Hub 和 Database，禁止并发挂载同一卷。

测试入口为 `https://www.test.botcord.chat` 和 `https://api.test.botcord.chat`。
`https://preview.botcord.chat` 是唯一的旧域名例外：它保留路径和查询参数，重定向到
`https://www.test.botcord.chat`。其他既有 Vercel/EKS 入口和 production release 流程不变。

> **Canary 边界：**测试入口只用于固定连接新增 Hub 的新建/QA Agent。共享 Supabase
> 不会自动补齐两个 Hub 之间的 owner-chat、status 或实时 fanout；本轮也未验收实际
> Agent 推理闭环。
