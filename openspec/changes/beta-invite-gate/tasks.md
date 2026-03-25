## 1. 后端数据库迁移

- [x] 1.1 在 `hub/models.py` 新增 `BetaInviteCode` 模型（id, code, label, max_uses, used_count, created_by, expires_at, status, created_at）
- [x] 1.2 在 `hub/models.py` 新增 `BetaCodeRedemption` 模型（id, code_id FK, user_id FK UNIQUE, redeemed_at）
- [x] 1.3 在 `hub/models.py` 新增 `BetaWaitlistEntry` 模型（id, user_id FK, email, note, status, applied_at, reviewed_at, sent_code_id FK）
- [x] 1.4 在 `public.users` 表新增 `beta_access bool default false` 和 `beta_admin bool default false` 字段
- [x] 1.5 生成并测试 Alembic 迁移文件

## 2. 后端 API — 用户侧

- [x] 2.1 新建 `app/routers/beta.py`，实现 `POST /app/beta/redeem`（验证码、检查用量/状态/过期、写兑换记录、更新 beta_access + Supabase user_metadata、返回成功）
- [x] 2.2 在 `beta.py` 实现 `POST /app/beta/waitlist`（检查重复申请、写 pending 记录）
- [x] 2.3 在 `hub/main.py` 注册 beta router
- [x] 2.4 为 `redeem` 和 `waitlist` 两个端点编写 pytest 测试（tests/test_app/test_app_beta.py）

## 3. 后端 API — Admin 侧

- [x] 3.1 新建 `app/routers/admin_beta.py`，添加 `beta_admin` 鉴权依赖
- [x] 3.2 实现 `GET /app/admin/beta/codes`（列表，支持 status 筛选）
- [x] 3.3 实现 `POST /app/admin/beta/codes`（创建码，nanoid 生成码值）
- [x] 3.4 实现 `POST /app/admin/beta/codes/{id}/revoke`（撤销码）
- [x] 3.5 实现 `GET /app/admin/beta/waitlist`（申请列表，支持 status 筛选）
- [x] 3.6 实现 `POST /app/admin/beta/waitlist/{id}/approve`（生成一次性码 → 调用 Supabase Email 发送邮件 → 更新申请状态）
- [x] 3.7 实现 `POST /app/admin/beta/waitlist/{id}/reject`（更新申请状态为 rejected）
- [x] 3.8 在 `hub/main.py` 注册 admin_beta router
- [x] 3.9 为 admin 端点编写 pytest 测试

## 4. 前端 — API 层

- [x] 4.1 在 `src/lib/api.ts` 新增 `betaApi.redeemCode(code)`、`betaApi.applyWaitlist(email, note)` 方法
- [x] 4.2 在 `src/lib/api.ts` 新增 `adminBetaApi.getCodes()`、`adminBetaApi.createCode(data)`、`adminBetaApi.revokeCode(id)`、`adminBetaApi.getWaitlist(status)`、`adminBetaApi.approveWaitlist(id)`、`adminBetaApi.rejectWaitlist(id)` 方法
- [x] 4.3 N/A — 前端直接调用后端 API，无 BFF 层

## 5. 前端 — /invite 页面

- [x] 5.1 新建 `src/app/invite/page.tsx`，不受 beta middleware 拦截（加入 matcher 白名单）
- [x] 5.2 实现邀请码输入区（输入框 + 激活按钮 + 错误提示），激活成功后调用 `supabase.auth.refreshSession()` 再 redirect `/chats`
- [x] 5.3 实现等待列表申请区（邮箱输入 + 可选说明 + 提交按钮 + 成功/错误状态）
- [x] 5.4 处理已激活用户访问 /invite 的状态（显示"已激活"+ 跳转按钮）
- [x] 5.5 处理未登录用户访问 /invite 的状态（操作按钮引导登录）
- [x] 5.6 URL query param `?code=XXXX` 自动填入邀请码输入框（来自邮件链接）

## 6. 前端 — Middleware 拦截

- [x] 6.1 修改 `middleware.ts`：在 matcher 中加入 `/chats/:path*`
- [x] 6.2 在 middleware 中读取 Supabase session，从 `user_metadata.beta_access` 判断准入状态
- [x] 6.3 `beta_access=false` 时 redirect `/invite`，`beta_access=true` 放行

## 7. 前端 — /admin 页面

- [x] 7.1 新建 `src/app/admin/layout.tsx`，检查 `beta_admin` 权限，非 admin redirect 首页
- [x] 7.2 新建 `src/app/admin/codes/page.tsx`：表格展示码列表（码值/label/用量/状态），创建新码表单，撤销按钮
- [x] 7.3 新建 `src/app/admin/waitlist/page.tsx`：申请列表表格（邮箱/说明/状态/申请时间），通过/拒绝按钮，邮件失败时展示激活码

## 8. 前端 — Drizzle Schema 同步

- [x] 8.1 在 `frontend/db/schema/` 新增 `beta.ts`，定义 `betaInviteCodes`、`betaCodeRedemptions`、`betaWaitlistEntries` 表
- [x] 8.2 在 `frontend/db/schema/users.ts` 新增 `betaAccess` 和 `betaAdmin` 字段
- [x] 8.3 生成 Drizzle 迁移并验证 schema 与后端一致

## 9. 验收测试

- [ ] 9.1 手动验证：未激活用户访问 /chats → redirect /invite（需运行迁移后测试）
- [ ] 9.2 手动验证：输入 KOL 码 → 激活成功 → redirect /chats
- [ ] 9.3 手动验证：超限码 / 已撤销码 → 错误提示
- [ ] 9.4 手动验证：提交 waitlist → /admin 出现申请 → 审批 → 邮件到达 → 填码激活
- [ ] 9.5 手动验证：/admin 非 admin 用户访问 → 403 / redirect
