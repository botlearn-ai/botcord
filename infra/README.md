# BotCord infrastructure

本目录覆盖 BotCord 的常驻服务闭环：Next.js frontend、Hub、Gateway Ingress、
PostgreSQL 和 Redis。CLI、daemon 与 desktop 是客户端或按需进程，不作为这里的常驻容器。

- [`compose/`](compose/README.md)：本地源码构建；frontend `18080`、Hub `18000`、
  Gateway health `19100` 均只绑定 loopback。
- [`dokploy/`](dokploy/README.md)：远端预构建镜像；frontend 与 Hub 通过独立 HTTPS
  域名公开，Gateway、PostgreSQL 和 Redis 保持私有，无 host port。后续测试发布统一
  走 GitHub Provider + CI 固定提交/镜像，生产 release 路径不变。
- [`dokploy/DEPLOYMENT.md`](dokploy/DEPLOYMENT.md)：当前 Dokploy 资源、镜像摘要、
  验收证据和未覆盖边界。

```bash
pnpm compose:up
pnpm compose:ps
pnpm compose:logs
pnpm compose:down # 保留数据、uploads 与 Gateway secrets
pnpm infra:check
```

## 当前数据边界

按用户确认，**不部署新的 Supabase**。本地和 Dokploy 的 frontend/Hub 均复用已授权的
现有 Preview Supabase 项目，并连接同一个应用数据库；Supabase 继续提供 Auth、Realtime
和 Storage。仓库只保存变量名与示例，真实值在忽略的本地 `0600` 文件或 Dokploy
Environment 中。

当前实例走 Supabase JWKS 验签路径；Hub 运行时还必须具备同一项目的 service-role 和
Storage bucket 配置。它们均为服务端配置，不进入 frontend build args。

最初创建的独立 PostgreSQL 容器和卷仍保留且 healthy，但当前不承载业务数据；不要删除
或把它描述为已迁移数据。新增 Hub 使用本部署的独立 Redis；旧 Preview Redis 位于
`us-east-1` 私网 ElastiCache，当前香港主机不可达，本次没有改造这段拓扑。

> **Canary 边界：**远端新入口只用于固定连接新增 Hub 的新建/QA Agent，并按单 Hub canary
> 验证。不要让仍回调旧 Hub 的既有 Agent 改用该入口，也不要把两个 Hub 描述为
> active-active。共享 Supabase 只保证持久数据共用；owner-chat 流、status 和实时 fanout
> 没有跨新旧 Hub 闭环，且本轮未实际执行 Agent 推理闭环。

新增 Hub 对共享数据库关闭 schema auto-create 和周期后台任务，不争抢 DDL 与任务所有权。
Dokploy 使用 `https://www.test.botcord.chat` 和 `https://api.test.botcord.chat`，不改变既有
Vercel/EKS 入口。

## 已验证范围

两个公开 Domain 已部署：HTTPS 有效、HTTP 301 跳转、Hub health 与精确 frontend Origin
的 CORS 均为 200。fresh browser 已完成匿名登录边界、邮箱密码登录、Dashboard、Messages、
BFF 和 21 个静态资源验收；57 个登录态请求（含 12 个 API）均低于 400，page errors、
Analytics 和 localhost 请求均为零。auth callback 返回公开域名，不再跳到容器地址。

仍未验证实际 Agent 推理闭环、Google/GitHub 账号授权、支付、邮件和其他付费集成。
