## ADDED Requirements

### Requirement: /admin 页面仅对 beta_admin 用户可见

系统 SHALL 对所有 `/admin/**` 路由在 API handler 层检查 `user.beta_admin===true`，非 admin 用户返回 403 或重定向首页。

#### Scenario: 非 admin 用户访问 /admin
- **WHEN** `beta_admin=false` 的用户访问 `/admin`
- **THEN** 页面重定向至首页，API 请求返回 403

#### Scenario: admin 用户正常访问
- **WHEN** `beta_admin=true` 的用户访问 `/admin`
- **THEN** 页面正常渲染，显示码管理和等待列表两个 tab

---

### Requirement: 邀请码管理 Tab 显示码列表和创建功能

管理员 SHALL 能在 /admin/codes 查看所有邀请码的当前状态（码值、标注、用量、状态），并创建新码或撤销现有码。

#### Scenario: 查看码列表
- **WHEN** 管理员打开 /admin/codes
- **THEN** 以表格形式显示：码值、label、used_count/max_uses、status、创建时间，支持按 status 筛选

#### Scenario: 创建新码
- **WHEN** 管理员点击"创建新码"，填写 label 和 max_uses 后提交
- **THEN** 系统生成新码，立即出现在列表中

---

### Requirement: 等待列表 Tab 显示申请并支持审批

管理员 SHALL 能在 /admin/waitlist 一键完成审批操作，操作结果实时反映在列表中。

#### Scenario: 通过操作的即时反馈
- **WHEN** 管理员点击"通过"并邮件发送成功
- **THEN** 该申请行状态变为 approved，显示已发送的激活码

#### Scenario: 邮件发送失败的降级
- **WHEN** 审批通过但邮件发送失败
- **THEN** 申请仍变为 approved，UI 显示警告"邮件发送失败，请手动告知用户激活码：XXXX"，激活码在 UI 中可见可复制
