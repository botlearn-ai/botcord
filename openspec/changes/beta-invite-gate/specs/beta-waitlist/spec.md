## ADDED Requirements

### Requirement: 已登录用户可提交等待列表申请

已登录用户 SHALL 能在 `/invite` 页面下方填写邮箱和可选说明，提交等待列表申请。同一用户只能有一条有效申请（`pending` 或 `approved`）。

#### Scenario: 首次申请成功
- **WHEN** 已登录用户填写邮箱并提交申请
- **THEN** 系统创建 `status=pending` 的申请记录，页面显示"申请已提交，审核通过后将发送邮件"

#### Scenario: 重复申请被拦截
- **WHEN** 用户已有 pending/approved 申请时再次提交
- **THEN** 系统返回错误"你已提交过申请"，不重复写入

#### Scenario: 已激活用户无需申请
- **WHEN** `beta_access=true` 的用户访问 /invite
- **THEN** 申请表单不可见，显示已激活状态

---

### Requirement: 管理员可审批等待列表申请

管理员 SHALL 能在 `/admin/waitlist` 查看所有 `pending` 申请，并对每条申请执行通过或拒绝操作。

#### Scenario: 通过申请
- **WHEN** 管理员点击"通过"某条申请
- **THEN** 系统：1）生成 `max_uses=1` 的一次性激活码；2）发送邮件给申请邮箱（含激活码和激活链接）；3）申请 status 变为 approved；4）sent_code_id 指向新码

#### Scenario: 拒绝申请
- **WHEN** 管理员点击"拒绝"某条申请
- **THEN** 申请 status 变为 rejected，不发送邮件，不生成激活码

#### Scenario: 审批邮件内容
- **WHEN** 审批通过邮件发送
- **THEN** 邮件包含：激活码明文、激活页面完整链接（`https://botcord.chat/invite?code=XXXX`）、有效期说明

---

### Requirement: 申请列表支持按状态筛选

管理员页面 SHALL 默认显示 `pending` 申请，支持切换查看 `approved` 和 `rejected`。

#### Scenario: 默认视图
- **WHEN** 管理员打开 /admin/waitlist
- **THEN** 默认显示所有 pending 申请，按申请时间倒序排列

#### Scenario: 筛选 approved
- **WHEN** 管理员选择"已通过"筛选
- **THEN** 显示所有 approved 申请，同时展示已发送的激活码
