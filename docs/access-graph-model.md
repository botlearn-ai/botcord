# 核心领域模型：主体 + 关系图 + 任务

> 状态：方案已确认（2026-10-08），字段细节在实现 PR 中评审。
> 本文是数据结构、授权和回复策略的目标模型。后续涉及身份、组织、共享、对外服务、任务的改动，都应向本文收敛。
> 相关文档：`team-identity-space-design.md`、`team-task-authorization-design.md`、`agent-sharing-design.md`。

## 1. 为什么重新定义

现有模型是"先有个人，再加团队"演进出来的，问题集中在三处：

- 个人模式和 Team 模式是两套结构（房间 `space_id` 可空、两套列表、两套授权）。
- "谁能让这个 agent 做什么"分散在 5 处：`Contact`、`Agent.contact_policy` / `message_policy`、房间成员权限、`AgentAccessGrant`、`AgentManagementGrant`，daemon 还在本地再推断一次。
- 跨边界的使用（个人调用组织公开的 agent、A 公司调用 B 公司的 agent）没有对应的对象。

目标模型：

| 层 | 内容 | 回答的问题 |
|---|---|---|
| 节点 | 主体（User、Agent、Organization）+ 资源（Conversation） | 谁、在哪 |
| 边 | Access：有类型、有方向的关系 | 凭什么能用 |
| 规则 | 每种动作允许哪些路径 | 能不能做、能做到哪一步 |
| 回复策略 | 按范围覆盖的唤醒规则 | 要不要回 |
| 业务 | Task | 做了什么、结果如何、谁付钱 |

参考：Google Zanzibar 及其开源实现 SpiceDB / OpenFGA——主体和资源都是节点，权限是按动作定义的路径规则。

## 2. 节点

| 节点 | id | 说明 |
|---|---|---|
| User | `hu_` | 人 |
| Agent | `ag_` | Ed25519 身份全局唯一 |
| Organization | `og_`（新增） | 可以拥有 agent、持有钱包、下单采购 |
| 任何人（虚拟） | `pr_public` | 只作为 offer 边的起点，表示公开 |
| Conversation | `rm_` | 资源节点：群、私聊、owner-chat |

主体统一登记在 `principals` 表（id、kind、display_name、avatar_url、status）。users / agents / organizations 保留各自的详情表；边的端点外键指向 `principals`，保证引用完整，列表展示也只需 join 一张表。Conversation 不进 `principals`，边指向它时用 `to_kind = 'conversation'`。

"个人空间"不再是独立概念：个人的资源归属 User，组织的资源归属 Organization。`spaces` 表保留为组织的内部实现，`personal_spaces` 不再使用。

## 3. 边

### 3.1 边的种类

| kind | from（持有方） | to（对象） | 主要属性 | issued_by |
|---|---|---|---|---|
| ownership | User / Org | Agent | — | 系统 / 转让人 |
| membership | User | Org | role: owner / admin / member | 管理员或邀请链接 |
| membership | Agent | Org | role: participant | 组织管理员 |
| member | User / Agent | Conversation | role: owner / admin / member | 拉人的一方 |
| grant | User | Agent | capability: consult / collaborate；约束（workspace、命令白名单、额度）；`scope_org_id` | agent 的 owner |
| manage | User | Agent | 可管理的范围 | agent 的 owner |
| offer | 任何人 | Agent | 能力上限、受众（人 / agent）、允许被拉进群、价格、数据条款 | agent 的 owner |
| order | User / Org | Agent | 下单时的条款快照、预算 | 买方 |
| connection | 被接纳方 | 接纳方 | capability（默认取接纳方 owner 的个人默认档位）、接纳方给的备注 | 接纳方（agent 由其 owner 代为接受） |
| block | 主体 | 主体 | — | 拉黑方 |

### 3.2 建模规则

- **一条边 = 一种关系 = 一个独立的生命周期。** 两个节点之间可以有多条边（多重图）。"A 和 B 是什么关系"是这些有效边的集合。
- **能独立授予、独立撤销的，拆成不同的边**；同一种关系的不同等级用属性（membership 的 role，grant 的 capability）；语义不同的能力拆成不同的 kind（grant 与 manage）。
- **方向**：from 是持有能力的一方，to 是被作用的对象。谁创建了边记在 `issued_by`，不用方向表达。
- **对称关系存成两条有向边**：A 加 B 为好友且 B 接受后，有 A→B（B 签发，表示 B 接纳 A）和 B→A（A 签发）两条；"互为联系人"即两条都存在；好友申请是一条 `pending` 的边，由被申请方接受后变为 active。
- **依赖**：一条边的有效性依赖其他边时，记在 `access_edge_deps`。被依赖的边一变（撤销、过期、version 递增），在同一事务里使依赖它的边失效。例：组织内 grant 依赖"被授权人 → 组织"和"agent → 组织"两条 membership。
- **否定边优先**：存在 block 时，任何路径都判为拒绝。
- **唯一性**：有效边按 `(kind, from_id, to_id, coalesce(scope_org_id, ''))` 唯一，只约束 `pending / active`。
- **新增 kind 或新增允许的路径需要明确评审**；每种 kind 的端点类型和 `terms` 结构用 check 约束 + 应用层 schema 校验。

### 3.3 表结构

```
principals
  id text PK, kind, display_name, avatar_url, status, created_at

access_edges
  id uuid PK, kind,
  from_id, from_kind, to_id, to_kind,
  scope_org_id (nullable),
  role, terms jsonb,
  status  pending | active | revoked | expired,
  version, issued_by, expires_at, revoked_at, created_at, updated_at
  部分唯一索引 (kind, from_id, to_id, coalesce(scope_org_id,'')) where status in (pending, active)
  索引 (from_id, kind) where active；(to_id, kind) where active；(scope_org_id, kind)

access_edge_deps
  edge_id, depends_on_edge_id, depends_on_version
  索引 (depends_on_edge_id)

access_edge_events（只追加）
  id, edge_id, event, actor_id, version, before jsonb, after jsonb, at
```

会话里的界面状态（已读时间、免打扰）不进边表，留在会话状态表（由现有 `room_members` 精简而来）。边表只放和权限相关、变化频率低的关系。

## 4. 授权规则

按动作定义允许的路径，最多两跳：

| 动作 | 允许的路径 | 能力 |
|---|---|---|
| 私聊 / 派活给 agent | 我 —ownership→ agent | 完整 |
| | 我 —grant→ agent（依赖 我 —membership→ 组织 且 agent 在该组织） | grant 上的能力 |
| | 我 —membership→ 组织 —ownership→ agent | 组织策略的默认值 |
| | 我 —order→ agent | order 条款 |
| | 我 —membership→ 组织 —order→ agent | order 条款 ∩ 组织策略 |
| | 任何人 —offer→ agent | offer 能力上限 |
| | 我 —connection→ agent（agent 一方已接纳我） | 这条边上的 capability |
| 在群里 @agent | 我 —member→ 群 ←member— agent | 群 / 组织策略的默认值（默认 consult） |
| 把 agent 拉进群 | 我是 agent 的 owner / 组织管理员（agent 在该组织），或 offer 允许被拉进群 | — |
| 进入组织群 | 我 —membership→ 组织 | — |

要点：

- **同在一个群，只能在群里使用 agent，不能凭此私聊。** 私聊必须有一条通向 agent 的边（现有"同房间即可私聊"的放行在切换时取消，切换前统计受影响的私聊数）。
- **同一个 owner 不需要边**：由双方的 ownership 边推出。
- 能力取路径上的最小值，再与提供方、使用方策略取交集。

判定函数 `decide(调用人, 动作, 对象, 上下文)` / `decide_many(...)`（inbox 按批）返回：

- 是否允许，以及依据的路径（边 id + version）；
- 执行档位；
- 付费方：路径上持有 order 的主体；
- 拒绝原因：边失效、过期、存在 block、超出预算等。

只有 Hub 做判定，所有入口（dashboard、inbox、gateway、以后的 GitHub）调用同一个函数。判定结果随消息下发，daemon / cloud 只执行；本地配置只能更严，不能放宽。

**加速表**：现在不建闭包表或物化视图。两跳路径走索引即可；派生表扇出大（组织采购要按成员展开，公开 offer 无法展开），且有一致性风险。等 `decide()` p95 > 5ms 或单个组织 > 1000 人时，再为"我能用的 agent"一个查询建只读派生表，可随时从边表重建；offer 路径始终在运行时判定。

## 5. 回复策略

回复策略回答"这条消息要不要唤醒 agent"，不在图里。处理一条消息时：

1. 先过授权（第 4 节）；不通过直接拒绝。
2. 再按回复策略决定是否唤醒。

回复策略**只能收窄，不能放宽**：名单里的人如果在图上没有路径，仍然不能使用 agent。

规则表（由现有 `AgentRoomPolicyOverride` 扩展）：

```
agent_reply_rules
  agent_id,
  conversation_id (nullable = 所有会话),
  sender_id       (nullable = 所有人),
  attention_mode  always | mention_only | keyword | allowed_senders,
  keywords, muted_until, updated_at
  唯一 (agent_id, conversation_id, sender_id)
```

匹配时越具体越优先：

| 优先级 | 范围 |
|---|---|
| 1 | 某个会话里的某个人 |
| 2 | 某个会话 |
| 3 | 某个人（所有会话） |
| 4 | agent 默认（现有 `Agent.default_attention` / `attention_keywords`） |

不挂在边上的原因：按人的规则不一定对应任何边；回复策略是 owner 常改的偏好，边是需要审计的授权。两者用同一套 id，可以在同一个设置界面展示。

是否唤醒改由 Hub 计算，和执行档位一起下发；daemon 不再自己判断。

## 6. 任务

```
Task = 请求人 → agent + 路径快照 + 输入 + 状态 + 交付物 + 验收 + 费用
状态：requested → running → delivered → accepted / rejected（另有 failed、cancelled）
```

- 每次非 owner 调用 agent 都是一个 Task：
  - 隐式任务：在私聊或群里直接请求，默认视为接受，用户可改为拒绝；
  - 显式任务：正式派活，需要请求人验收（如 PR 合并）。
- owner 自用可不生成 Task 或只记轻量记录；人和人聊天不产生 Task。
- Task 记录只追加，是信誉和结算的唯一来源。
- 在群里显式派活时，Task 对应一个 Topic 作为讨论串；隐式 Task 关联触发它的消息。Topic 的 `goal/status` 在 Task 上线后以 Task 为准。

## 7. 现有数据迁移

| 现有 | prod 行数（10-08） | 目标 |
|---|---|---|
| `agents.user_id` | 124 | ownership（User → Agent） |
| `space_user_memberships` + `space_role_bindings` | 8 | membership（User → Org），role 取自 role_binding |
| `space_agent_memberships` | 2 | membership（Agent → Org），依赖担保人的 membership |
| `space_agent_profiles` | — | 保留，主键改为 agent membership 边 id |
| `agent_access_grants` | 2 | grant，依赖两条 membership |
| `agent_management_grants` | 2 | manage（先盘点调用方） |
| `contacts` | 98 | connection，备注进 terms |
| `contact_requests` | 27 | connection：pending / active / revoked |
| `blocks` | 0 | block |
| `contact_policy=open` 的 agent | 6 | offer（免费，consult），`allow_*_sender` 进 terms 的受众 |
| `room_invite_policy=open` | 3 | 同一条 offer 的 terms：允许被拉进群 |
| `contact_policy=whitelist` | 1 | 只认 connection |
| `contact_policy=closed` | 0 | 去掉 |
| `room_members` | 628 | member 边（User / Agent → Conversation）+ 会话状态表（已读、免打扰） |
| `rooms.owner_id` | 246 | 保留；组织群 owner 改为 `og_` |
| `AgentRoomPolicyOverride` | — | `agent_reply_rules` |
| `Topic.goal/status` | 183 | Task（上线后） |
| `SpaceInviteLink` / `Invite` | — | 产生 membership / member / connection 边的途径 |

迁移脚本可重复执行，迁完逐张旧表核对行数。

## 8. 实施顺序

| PR | 内容 |
|---|---|
| 1 | 新建 `principals`、`access_edges`、`access_edge_deps`、`access_edge_events`；组织加 `og_`；迁移脚本；所有写旧表的路径同时写边表（双写） |
| 2 | `decide()` / `decide_many()`，影子模式：与现有判定对账，不一致只记日志 |
| 3 | 组织、grant、manage 的读路径切到边表 |
| 4 | 回复规则表；inbox 下发统一判定结果（执行档位 + 是否唤醒），daemon 以 Hub 为准（发一版 daemon） |
| 5 | 联系人、拉黑、消息策略、群成员切到边表；取消"同房间即可私聊" |
| 6 | `Agent.user_id` 切到 ownership 边；停止双写，删除旧表和旧字段 |
| 后续 | Task；offer / order 下单 |

## 9. 决策与待定

已定（2026-10-08）：

- 好友（connection）边默认能力为 consult：可以互相交流，agent 按只读执行。存量好友边迁移时同样写为 consult；owner 可以单独调高某一条边。生效时间为 daemon 以 Hub 判定为准之后（第 8 节 PR 4）。

以后再定（做到对应功能时）：

- 组织钱包的归属与 `og_` 主体的计费细节。
- 组织成员在 Team 里调用外部 agent，默认代表组织还是个人（建议代表组织）。
- offer 的数据条款默认值（建议：提供方 owner 可见，保留 30 天）。
- 同一 agent 在不同组织的记忆是否默认隔离（建议隔离）。
