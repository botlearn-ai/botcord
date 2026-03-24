## Context

BotCord 当前无任何访问门槛，任何注册用户都可直接使用 `/chats`。随着 KOL 推广活动即将开展，需要在正式开放前建立一套公测准入层。

现有基础：Supabase Auth（用户认证）、RBAC roles 表（User/Role/Permission）、Next.js middleware（`middleware.ts`，目前仅处理 Supabase 会话刷新）、`public.users` 表（可扩展字段）。

## Goals / Non-Goals

**Goals:**
- 通过 `beta_access` 字段对所有 `/chats/**` 路由实施准入拦截
- 支持 KOL 专属多人码（管理员创建，KOL 分发给粉丝群）
- 支持用户自助申请等待列表，管理员审批后自动发送激活码邮件
- 提供极简 `/admin` 页面用于码管理和 waitlist 审批
- 审批流完全异步（管理员随时操作，用户收邮件后自行激活）

**Non-Goals:**
- 不做推荐奖励/裂变机制
- 不做批量导入邀请码
- 不做邀请码使用统计分析
- 不做自动审批逻辑（人工审批即可）
- 不对 `/chats` 以外的页面（如 `/protocol`、`/vision` 等营销页）做门禁

## Decisions

### D1：准入标志放在 `users` 表，而非 RBAC roles

**选择**：在 `public.users` 表新增 `beta_access bool default false` 和 `beta_admin bool default false`。

**理由**：RBAC 层（User/Role/Permission）是通用权限系统，beta 准入是临时的启动期机制，粒度粗（yes/no），混入 RBAC 会增加无谓复杂度。用字段更简洁，后续直接删字段即可下线该机制。

**替代方案**：在 RBAC roles 中建 `beta_user` / `beta_admin` 角色 → 否决，过度设计。

---

### D2：Middleware 层拦截，而非页面层守卫

**选择**：在 Next.js `middleware.ts` 中拦截 `/chats/**`，读取 Supabase session 中的用户数据（或调用 `/api/users/me` 获取 `beta_access`），false 时重定向 `/invite`。

**理由**：Middleware 在 Edge 层运行，拦截早、用户体验干净、不会闪烁。页面层守卫（在组件内 redirect）会导致短暂渲染再跳转。

**注意**：Middleware 需避免在 Edge 中直接查询 DB，应通过已有的 Supabase session token 调用 `/api/users/me` 获取 `beta_access` 状态，或将 `beta_access` 写入 Supabase user metadata 以便 Edge 直接读取。

**推荐实现**：激活邀请码时同时调用 `supabase.auth.admin.updateUserById` 将 `beta_access: true` 写入 `user_metadata`，middleware 直接从 JWT claims 读取，无需额外 API 调用。

---

### D3：KOL 码 vs Waitlist 码统一用同一张表

**选择**：`beta_invite_codes` 表统一存放所有码，通过 `max_uses` 字段区分：KOL 专属码 `max_uses > 1`，waitlist 一次性码 `max_uses = 1`，`label` 字段注明来源。

**理由**：兑换逻辑完全相同（验证码 → 检查用量 → 写 redemption → 更新 beta_access），无需为两种码维护两套流程。

---

### D4：邮件发送用 Supabase Email（SMTP）

**选择**：在后端（BFF `/api/admin/beta/waitlist/{id}/approve`）审批时，调用 Supabase Admin API 或配置的 SMTP 发送激活码邮件。

**邮件内容**：包含激活码、激活页面链接（`https://botcord.chat/invite?code=XXXX`）、有效期说明。

**替代方案**：Resend / SendGrid → 否决，项目已有 Supabase，不引入新依赖。

---

### D5：Admin 鉴权用 `beta_admin` 字段，不走中间件

**选择**：`/admin/**` 路由在 API handler 层检查 `user.beta_admin === true`，返回 403 拒绝。页面层做同样检查，非 admin 用户显示 404 or 重定向首页。

**理由**：Admin 页面是内部工具，初期直接用字段鉴权足够，后续可迁移到 RBAC。

## Risks / Trade-offs

| 风险 | 缓解措施 |
|---|---|
| Middleware 读 JWT metadata 有延迟（用户激活后旧 token 仍 false） | 激活成功后强制 `supabase.auth.refreshSession()`，刷新 JWT 再 redirect |
| 邮件发送失败导致用户拿不到激活码 | API 返回生成的码（admin 可手动告知）；前端 admin 界面显示已发送的码 |
| 码被暴力枚举（短码安全性） | 码用 `nanoid(10)` 生成，空间约 10^15，配合兑换失败次数限制（如 IP 维度） |
| KOL 码泄漏被滥用 | 支持撤销（`status=revoked`）；max_uses 上限 |

## Migration Plan

1. 后端 Alembic 迁移：新增 3 张表 + `users.beta_access` + `users.beta_admin`
2. 部署后端新路由
3. 部署前端新页面（`/invite`、`/admin`）
4. **最后一步**开启 middleware 拦截（feature flag 或直接上线）
5. 回滚：关闭 middleware 拦截即恢复原状，数据表保留不删

## Open Questions

- Supabase Email 的 SMTP 是否已在项目中配置？（如未配置，需先在 Supabase 控制台开启自定义 SMTP）
- 激活码邮件模板是否需要品牌化设计，还是纯文本即可？
- `beta_access` 是否需要有效期（过期自动降级），还是永久激活？
