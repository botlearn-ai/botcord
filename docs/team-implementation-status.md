# Team 实施进度

2026-09-09：已实现消息式组织工作区、组织房间和成员私聊，详见 [工作区实现与部署说明](team-workspace-messaging.md)。当前改动未部署；Agent 执行授权与私聊审计入口仍未开放。下方 2026-09-08 内容保留为上一批历史记录。

## 前端组织治理（2026-09-08）

- 账户菜单和设置导航增加“空间与组织”，地址 `/settings/spaces`。URL 的 `?space=<id>` 支持刷新及返回；选择只影响组织治理页面，个人聊天继续使用原上下文。
- 个人空间入口、待接受邀请提示、组织创建、接受邀请、成员邀请/退出/移除、Agent 申请/批准/移除和组织私聊政策设置均接入真实 Hub API。
- 邀请使用账户菜单已有的 `hu_…` 用户 ID。后端兼容既有 `user_id`，但两者必须恰好提供一个；先核验组织管理权限再解析目标身份。成员接口补充名称、Human ID、空间角色和 Agent sponsor 引用，不返回邮箱或其他空间关系；角色批量查询。
- 普通成员只能申请自己的 Agent 或退出，管理员可以治理成员及审批，政策只允许 owner 修改。移除与政策变更展示具体组织及影响范围，取消不发送请求；离开页面或切换空间会取消未决确认。
- 政策开关展示全部保留历史的范围和当前尚无内容查看入口；使用 `expected_version`，冲突后刷新并重新确认，不自动重试写入。组织对外通信不可开启。
- 页面按空间重新加载，旧请求取消并按版本丢弃迟到结果；失去成员身份时清空数据，不默默回落到个人空间。切换时隐藏旧空间正文，重复提交有保护，返回窗口时刷新成员和政策状态。
- 沿用主题和中英文，增加窄屏设置布局。浏览器连接连续超时，本轮未完成真实浏览器视觉/交互验收；自动化验证结果另记。

## 本批实现

- 10 张基础表：空间、个人空间、组织、组织政策、用户/Agent 成员、空间名片、Agent 所有权、空间角色与审计。保留组织所有权字段，不提供公共 Agent 创建入口。
- 新账号认证创建时在同一事务内建立个人空间；已有账号首次请求空间列表时幂等补齐。独立回填脚本处理有效用户及已认领的有效个人 Agent；Agent 入组申请也补齐个人所有权及成员关系。
- 用户由组织 owner/admin 邀请，本人接受后激活；不会自动导入其 Agent。
- Agent 由本人申请、组织 owner/admin 批准。本人同时是组织 owner 时可以完成两步。空间名片不修改全局名字。
- 用户退出/移除时，同步移除 sponsor 下的 Agent 成员及空间角色，递增版本并审计。重新入组需重新申请 Agent 接入，旧成员版本无效。每次成员检查核验 sponsor、空间状态、全局用户及 Agent 状态和所有权兼容镜像。
- 组织私聊管理政策默认关闭，只有 owner 可修改；`expected_version` 防覆盖，每次变更审计。对外通信开启请求直接拒绝。
- 组织变更在事务内锁定空间；个人空间初始化锁定用户，数据库唯一约束与复合外键兜底。组织 owner 移除暂时全部拒绝，后续单独实现多人 owner 与移交。

政策字段目前仅记录配置。尚无组织私聊内容审计入口，也不会因此放宽旧 Room ACL；接口明确返回 `content_audit_available=false`。空间列表返回 `organization_execution_available=false`。

## API

沿用项目实际 `/api` 前缀；设计文档中的 `/app` 为逻辑接口分类。

| 接口 | 行为 |
|---|---|
| `GET /api/spaces` | 本人的个人空间、组织成员关系和待接受邀请；含当前政策版本 |
| `POST /api/organizations` | 创建组织、默认政策及 owner 成员 |
| `POST /api/spaces/{space_id}/invitations` | 管理员邀请已有用户，body 提供 `user_id` 或 `human_id` 之一 |
| `POST /api/spaces/{space_id}/invitations/accept` | 本人接受邀请 |
| `GET /api/spaces/{space_id}/members` | 当前有效成员查询本空间成员 |
| `DELETE /api/spaces/{space_id}/members/{user_id}` | 本人退出或管理员移除；owner 不可移除 |
| `POST /api/spaces/{space_id}/agents/{agent_id}/admission` | Agent owner 申请入组 |
| `POST /api/spaces/{space_id}/agents/{agent_id}/admission/approve` | 组织批准申请 |
| `DELETE /api/spaces/{space_id}/agents/{agent_id}` | sponsor 或组织管理员移除 Agent |
| `PATCH /api/organizations/{organization_id}/policies` | owner 更新政策，必须携带 `expected_version` |

新接口仅接受用户认证，沿用 beta gate；Agent 管理授权凭据不能冒充人进行这些治理操作。空间角色独立于平台 `UserRole`。

## 数据库部署顺序

1. 先应用 `backend/migrations/002_team_identity_spaces.sql`，再部署引用新表的应用。SQL 使用当前 schema 的业务表及 `public.users`，可重复执行，不迁移旧消息和文件。
2. 从 `backend/` 执行 `uv run python scripts/backfill_personal_spaces.py`；逐用户提交，重跑不重复创建。跳过停用/封禁用户、未认领/停用 Agent。所有权冲突会失败，须核实后继续，不覆盖已有 owner。
3. 后续新认领 Agent 在回填或申请组织接入时补齐个人成员；全套 claim 生命周期双写仍待接入。业务授权目前不得仅信任所有权新表，检查必须同时核对 `Agent.user_id`。

本批未执行线上迁移或回填。初次全量测试发现既有 WebSocket presence 后台连接绕过测试 DB、读取本机数据库配置并产生外键错误；后续测试显式使用内存 SQLite，并清空外部支付配置。PostgreSQL 实际迁移及多连接并发锁行为还需在独立测试数据库验证；SQLite 行为测试不能代替这些验证。

## 后续批次

1. 请求侧规则、执行 grant、资源绑定及结果披露判定；区分指令人、Agent、动作、对象与目标。
2. task/operation、一次性审批、有限委托与受限工具代理；执行租约和幂等账本。
3. Room/Topic/消息/附件全部入口的空间边界、个人 DM 归属生命周期、协议签名与空间凭据。
4. daemon 按空间和授权上下文隔离会话、记忆与凭据；CLI 空间选择及前端组织聊天/任务上下文。组织治理页面已完成，跨客户端实时政策通知仍待接入。
5. 专用组织私聊审计入口与读取审计。完整链路验收后才开放组织通信/执行。

现有 `team-orchestration` 多 Agent 编排仍使用旧个人通信体系，本批不把它自动归为组织资源。

## 本轮验证

- 2026-09-08 UI 批次：前端 `npx vitest run` 为 239 passed（含 13 项 Team API/状态/页面渲染测试），`npm run build` 通过；后端 Team 专项 18 passed，隔离环境全量 1611 passed、30 skipped、44 warnings。成员列表批量角色查询改动另经专项回归通过。以下保留上一批验证记录。
- Team 专项：17 项通过；覆盖真实用户认证、双重入组确认、同一 Agent 的个人/多组织身份、撤权及重入、全局身份变化、政策版本、跨空间外键，以及提交失败不能返回成功。
- 后端全量：`DATABASE_URL='sqlite+aiosqlite:///:memory:' DATABASE_SCHEMA='' STRIPE_SECRET_KEY='' uv run pytest tests/ -q`，1610 passed、30 skipped。既有测试仍有 44 条警告，包括 WebSocket 后台连接清理；不等同于 PostgreSQL 环境验证。
- 初次沿用本机环境执行时，Stripe 测试因 SOCKS 依赖缺失失败（原始 HEAD 同样失败），WebSocket 心跳测试因后台数据库连接延迟失败。上述隔离环境全量运行均已通过，未修改这两处业务逻辑。
- 迁移 SQL 与 ORM 的 PostgreSQL 编译结果一致；文档链接和 `git diff --check` 通过。
