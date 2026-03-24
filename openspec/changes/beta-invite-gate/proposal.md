## Why

BotCord 即将进入 KOL 推广阶段，需要一套公测准入机制：通过邀请码控制用户访问，让大部分用户"能看不能用"，持码用户直接激活，无码用户可申请等待列表。这套机制既服务于 KOL 分发（专属多人码），也支持自助申请（等待列表 → 邮件发码）。

## What Changes

- 新增 `/invite` 页面：用户登录后无邀请码时的落地页，支持输入邀请码激活或申请等待列表
- 新增 `/admin` 页面：极简管理后台，支持创建 KOL 专属码、查看用量、审批等待列表申请
- 新增 Next.js middleware 拦截：`/chats/**` 路由检查 `beta_access`，未激活用户重定向至 `/invite`
- 后端新增 3 张表：`beta_invite_codes`、`beta_code_redemptions`、`beta_waitlist_entries`
- `users` 表新增 `beta_access`、`beta_admin` 两个 bool 字段
- 新增后端 API 路由：用户侧兑换/申请（2 个端点）+ Admin 侧管理（5 个端点）
- 审批等待列表时通过 Supabase Email 自动发送激活码邮件

## Capabilities

### New Capabilities

- `beta-access-gate`: 公测准入门禁 —— middleware 拦截 + /invite 落地页 + 邀请码激活流程
- `beta-invite-codes`: 邀请码管理 —— KOL 专属多人码的创建、分发、用量追踪、撤销
- `beta-waitlist`: 等待列表 —— 用户自助申请、Admin 审批、审批后自动生成一次性码并发邮件
- `beta-admin`: 管理后台 —— /admin 页面，管理码和等待列表，需要 beta_admin 权限

### Modified Capabilities

（无现有 spec 受影响）

## Impact

- **后端**：`hub/models.py` 新增 3 个模型；`alembic` 新增迁移；新增 `app/routers/beta.py`（用户侧）和 `app/routers/admin_beta.py`（admin 侧）；`hub/main.py` 注册新路由
- **前端**：新增 `src/app/invite/` 页面；新增 `src/app/admin/` 页面（codes + waitlist tab）；`middleware.ts` 新增 `/chats/**` 拦截逻辑；`src/lib/api.ts` 新增 beta 相关 API 方法；Drizzle schema 新增对应表
- **邮件**：依赖 Supabase Email（`supabase.auth.admin.sendRawEmail` 或 Supabase SMTP）发送激活码
- **权限**：`User` 表新增 `beta_admin` 字段，用于 admin 路由鉴权
