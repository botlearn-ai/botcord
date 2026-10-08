# 核心领域模型：主体 + 关系图 + 任务

> 状态：方向已确认（2026-10-08），字段细节待评审。
> 本文是数据结构和授权的目标模型。后续涉及身份、组织、共享、对外服务、任务的改动，都应向本文收敛。
> 相关文档：`team-identity-space-design.md`、`team-task-authorization-design.md`、`agent-sharing-design.md`。

## 1. 为什么重新定义

现有模型是"先有个人，再加团队"演进出来的，问题集中在三处：

- 个人模式和 Team 模式是两套结构（房间 `space_id` 可空、两套列表、两套授权）。
- "谁能让这个 agent 做什么"分散在 5 处：`Contact`、`Agent.message_policy`、房间成员权限、`AgentAccessGrant`、`AgentManagementGrant`，daemon 还在本地再推断一次。
- 跨边界的使用（个人调用组织公开的 agent、A 公司调用 B 公司的 agent）没有对应的对象。

目标模型把这些收敛成三层：

| 层 | 实体 | 回答的问题 |
|---|---|---|
| 主体 | User、Agent、Organization | 谁 |
| 关系 | Access（有类型的边） | 凭什么能用 |
| 业务 | Task | 做了什么、结果如何、谁付钱 |

Conversation / Topic / Message 是沟通设施，不承载权限，也不承载交易。

## 2. 主体（节点）

| 主体 | 说明 |
|---|---|
| User | 人。`hu_` |
| Agent | agent。`ag_`，Ed25519 身份全局唯一 |
| Organization | 组织。需要主体 id（如 `og_`），可以拥有 agent、持有钱包、下单采购 |
| 任何人（虚拟节点） | 只用作 offer 边的起点，表示公开 |

"个人空间"不再是独立概念：个人的资源直接归属 User，组织的资源直接归属 Organization。

## 3. 关系（边）

所有边存在一张表里，按 `kind` 区分，每种 kind 限定起点、终点类型和 `terms` 格式。

| kind | 方向 | 主要属性 | 含义 |
|---|---|---|---|
| ownership | User / Org → Agent | — | 拥有 |
| membership | User → Org | role: owner / admin / member | 组织成员 |
| membership | Agent → Org | role: participant | agent 加入组织 |
| grant | User → Agent | capability: consult / collaborate / manage；约束（workspace、命令白名单、额度）；`scope_org_id` | 组织内共享 |
| offer | 任何人 → Agent | 能力上限、价格、数据条款 | 公开服务 |
| order | User / Org → Agent | 下单时的条款快照、预算 | 个人下单或组织采购 |
| connection | 主体 ↔ 主体 | — | 联系人，决定能否发起私聊 |
| block | 主体 → 主体 | — | 拉黑，否决所有路径 |

通用字段：

```
id, kind, from_type, from_id, to_type, to_id, role, terms(jsonb),
scope_org_id, status, version, issued_by, expires_at, revoked_at, created_at
```

约束：

- 每种 kind 的端点类型和 `terms` 结构用 check 约束 + 应用层 schema 校验，禁止"什么都能塞"。
- 新增 kind 或新增允许的路径需要明确评审。
- 沿用现有做法：依赖的边带 `version`，被依赖的边一变，依赖它的边自动失效。

## 4. 授权：白名单路径，最多两跳

| 路径 | 场景 |
|---|---|
| 我 —ownership→ agent | 用自己的 agent |
| 我 —grant→ agent（要求 我 —membership→ 组织，且 agent 在该组织） | 组织内共享 |
| 我 —membership→ 组织 —ownership→ agent | 使用组织拥有的 agent |
| 我 —order→ agent | 个人下单 |
| 我 —membership→ 组织 —order→ agent | 组织采购，成员使用 |

判定函数 `decide(调用人, 动作, agent, 上下文)` 返回：

- 是否允许，以及依据的路径（边 id + version）；
- 执行档位：路径上能力的最小值，再与提供方、使用方策略取交集；
- 付费方：路径上持有 order 的主体；
- 拒绝原因：边失效、过期、存在 block、超出预算等。

只有 Hub 做判定。判定结果随消息下发给执行端（daemon / cloud），执行端只负责执行；本地配置只能更严，不能放宽。所有入口（dashboard、inbox、gateway、以后的 GitHub）都调用同一个 `decide()`。

## 5. 任务

```
Task = 请求人 → agent + 路径快照 + 输入 + 状态 + 交付物 + 验收 + 费用
状态：requested → running → delivered → accepted / rejected（另有 failed、cancelled）
```

- 每次非 owner 调用 agent 都是一个 Task：
  - 隐式任务：在私聊或房间里直接请求，默认视为接受，用户可改为拒绝；
  - 显式任务：正式派活，需要请求人验收（如 PR 合并）。
- owner 自用可不生成 Task 或只记轻量记录；人和人聊天不产生 Task。
- Task 记录只追加，是信誉和结算的唯一来源。

## 6. 沟通设施

| 对象 | 说明 |
|---|---|
| Conversation | 消息容器：人与人私聊、人与 agent 私聊、owner-chat、房间。有一个归属主体（组织房间归组织，个人群归创建人，私聊由双方关系约束） |
| Topic | 会话内的讨论分区。显式 Task 在房间里对应一个 Topic；Topic 的 `goal/status` 在 Task 上线后以 Task 为准 |
| Message | 签名信封，协议层不变，增加 `task_id` 引用 |

能否进入会话、能否把 agent 拉进会话，由第 4 节的路径判定。

## 7. 和现有表的映射

| 现有 | 目标 |
|---|---|
| `AgentOwnership` / `Agent.user_id` | ownership 边 |
| `SpaceUserMembership` + `SpaceRoleBinding` | membership 边（User → Org） |
| `SpaceAgentMembership` | membership 边（Agent → Org） |
| `AgentAccessGrant` | grant 边 |
| `AgentManagementGrant` | grant 边（capability = manage），需先盘点调用方 |
| `Agent.message_policy` 开放 | offer 边（免费） |
| `Contact` / `Block` | connection / block 边 |
| `Space` / `PersonalSpace` | 去掉；Organization 作为主体 |
| `Room.space_id` | Conversation 的归属主体 |
| `Topic.goal/status` | Task |
| `SpaceInviteLink` / `Invite` | 产生 membership / connection 边的途径 |

## 8. 迁移顺序（草案）

1. 建 `access_edges` 表，从现有表回填，双写。
2. 实现 `decide()`，影子模式运行：新旧判定同时跑，不一致只记日志。
3. 对账无差异后切到 `decide()`；inbox 下发统一判定结果，daemon 以 Hub 为准。
4. 新增 Task，接上协作者 PR 流程和隐式任务。
5. 加 offer / order，支持个人下单。
6. 下线旧授权表；`Agent.user_id` 分批替换为 ownership 边。

## 9. 待定

- Organization 主体 id 前缀和钱包归属。
- 组织成员在 Team 里调用外部 agent，默认代表组织还是个人。
- offer 的数据条款默认值（建议：提供方 owner 可见，保留 30 天）。
- 同一 agent 在不同组织的记忆是否默认隔离（建议隔离）。
