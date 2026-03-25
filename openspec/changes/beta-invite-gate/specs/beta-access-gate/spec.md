## ADDED Requirements

### Requirement: /chats 路由对未激活用户强制重定向

未激活用户（`beta_access=false`）访问任何 `/chats/**` 路径时，系统 SHALL 将其重定向至 `/invite`。未登录用户不受此影响，由现有 auth middleware 处理。

#### Scenario: 未激活用户访问 /chats/messages
- **WHEN** `beta_access=false` 的已登录用户访问 `/chats/messages`
- **THEN** 系统重定向至 `/invite`，不渲染 /chats 内容

#### Scenario: 已激活用户正常访问 /chats
- **WHEN** `beta_access=true` 的已登录用户访问 `/chats/messages`
- **THEN** 系统正常渲染 /chats 页面，无拦截

#### Scenario: /invite 页面本身不被拦截
- **WHEN** 任何用户访问 `/invite`
- **THEN** 系统正常渲染 /invite 页面，不触发 beta 门禁重定向

---

### Requirement: /invite 页面提供邀请码激活入口

`/invite` 页面 SHALL 提供两个并列功能区：输入邀请码激活 和 申请等待列表。页面对已登录和未登录用户均可访问，但激活/申请操作需要登录状态。

#### Scenario: 未登录用户访问 /invite
- **WHEN** 未登录用户访问 `/invite`
- **THEN** 页面正常渲染，操作按钮点击时引导登录

#### Scenario: 已激活用户访问 /invite
- **WHEN** `beta_access=true` 的用户访问 `/invite`
- **THEN** 页面显示"已激活"状态，提供跳转 `/chats` 的按钮

---

### Requirement: 激活成功后 JWT 立即刷新

用户成功兑换邀请码后，系统 SHALL 调用 Supabase `refreshSession()` 刷新 JWT，使 `beta_access=true` 立即生效，再跳转至 `/chats`。

#### Scenario: 激活后无感跳转
- **WHEN** 用户输入有效邀请码并点击激活
- **THEN** 系统：1）后端更新 `beta_access` 并写入 user_metadata；2）前端刷新 session；3）redirect 至 `/chats`
