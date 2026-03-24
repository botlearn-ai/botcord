## ADDED Requirements

### Requirement: 管理员可创建 KOL 专属邀请码

管理员（`beta_admin=true`）SHALL 能通过 `/admin` 页面创建邀请码，指定：码值（或自动生成）、标注（label，如 KOL 名称/活动名）、最大使用次数（`max_uses`）、可选过期时间。

#### Scenario: 创建 KOL 专属码
- **WHEN** 管理员在 /admin/codes 填写 label="TechWave大会"、max_uses=500 并提交
- **THEN** 系统生成唯一码（如 `KOL-TECHWAVE-A3X9`）并显示在列表中，status=active，used_count=0

#### Scenario: 码值重复时报错
- **WHEN** 管理员尝试创建已存在的码值
- **THEN** 系统返回错误，提示码已存在

---

### Requirement: 用户可兑换邀请码激活公测资格

已登录用户 SHALL 能在 `/invite` 页面输入邀请码，系统验证后将 `beta_access` 置为 true。

#### Scenario: 有效码成功兑换
- **WHEN** 用户提交有效且未超限的邀请码
- **THEN** 系统记录兑换关系、`users.beta_access=true`、`used_count+1`，返回成功

#### Scenario: 同一用户重复兑换同一码
- **WHEN** `beta_access=true` 的用户再次提交同一码
- **THEN** 系统幂等返回成功，不重复写入兑换记录，不重复计数

#### Scenario: 码已超过最大使用次数
- **WHEN** 用户提交 `used_count >= max_uses` 的码
- **THEN** 系统返回错误"邀请码已被使用完"

#### Scenario: 码不存在或已撤销
- **WHEN** 用户提交不存在或 `status=revoked` 的码
- **THEN** 系统返回错误"邀请码无效"，不泄露具体原因

#### Scenario: 已过期的码
- **WHEN** 用户提交 `expires_at` 已过期的码
- **THEN** 系统返回错误"邀请码已过期"

---

### Requirement: 管理员可撤销邀请码

管理员 SHALL 能将任意 `status=active` 的码撤销为 `status=revoked`，撤销后该码不可继续兑换，已兑换用户的 `beta_access` 不受影响。

#### Scenario: 撤销生效
- **WHEN** 管理员点击撤销某码
- **THEN** 码 status 变为 revoked，已兑换用户的访问权限保持不变

#### Scenario: 撤销后尝试兑换
- **WHEN** 用户提交已撤销的码
- **THEN** 系统返回"邀请码无效"
