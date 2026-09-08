# Team 模式：身份、空间与授权设计

> 日期：2026-09-07。状态：目标设计规格；身份基础已开始实现，详见 [实施进度](team-implementation-status.md)，其他章节不能视为已交付能力。
> 本文落实用户确认的“全局身份 + 空间成员身份 + 有范围的授权”。与 `org-agent-a2a-proposal.md` 冲突时，身份、隔离与授权以本文为准；执行体接入仍遵循原提案最新的 daemon 主路径。
> 任务授权细则见 [指令人、执行者、操作对象与结果接收方](team-task-authorization-design.md)，其中请求侧规则、有限委托、资源代理、结果披露及任务上下文隔离细化本文的概括模型。

## 0. 已确认的第一版范围

- 组织对外通信关闭；数据模型保留未来授权与目标扩展，第一版接口不能开启。
- 组织管理员默认不能读工作私聊，提供组织级开关；开关不影响个人空间。开关治理、历史范围和读取审计见任务授权规格第 8 节。
- 第一版不提供组织公共 Agent；只实现个人 Agent 加入组织，所有权结构保留扩展位置。
- 权限同时限定指令人、执行 Agent、动作、操作对象和结果接收方；工具白名单不能替代这些授权。

## 1. 产品语义与不变量

同一个用户和个人 Agent 可以同时使用个人模式及多个组织空间。模式切换只选择新操作的上下文，不改变全局身份、不转移数据归属、不改变正在执行的任务。

- User 是人的全局账号；现有 `human_id` 是该用户的消息主体标识，不新建另一套人类身份。
- Agent 是独立行动主体；owner 管理关系不意味着 Agent 自动取得 owner 的权限。
- Space 是资源治理与授权边界；个人模式也有明确空间，不用空组织字段表达多个含义。
- Membership 是主体在空间中的成员身份；用户入组与 Agent 入组分别授权。
- Grant 是对动作和资源范围的授权；展示职能、名字、提示词均不产生权限。
- Executor 是执行实例，runtime 是执行工具类型；均不取代 Agent 身份。
- 一个资源只有一个权威归属空间。进入组织、切换页面和退出组织都不隐式搬迁资源。
- 同一 Agent 在两个空间的会话、工作记忆和工具凭据必须隔离；空间显示名隔离不等于执行隔离。
- 共用 `agent_id` 不提供身份不可关联性；需要不可关联的场景使用独立 Agent 和密钥。

## 2. 数据模型

以下是目标逻辑模型，实际迁移沿用项目现有 UUID、时间与 schema 约定。权限关键字段使用类型、外键、唯一约束，不能只放入无约束 JSON。

| 表 | 关键字段与约束 | 职责 |
|---|---|---|
| `spaces` | `id`, `kind`, `status`, `policy_version`, `settings` | `kind=personal/organization`；`status=active/suspended/archived` |
| `personal_spaces` | `space_id` PK/FK, `user_id` UNIQUE/FK | 一用户一个个人空间；创建时校验 space kind |
| `organizations` | `id`, `space_id` UNIQUE/FK, `slug` UNIQUE, `name` | 组织业务实体；第一版一组织一空间，保留未来组织与空间分离可能 |
| `space_user_memberships` | `id`, `space_id`, `user_id`, `status`, `version`; UNIQUE `(space_id,user_id)` | 人的成员关系与生命周期 |
| `space_agent_memberships` | `id`, `space_id`, `agent_id`, `sponsor_user_membership_id`, `status`, `version`; UNIQUE `(space_id,agent_id)` | Agent 显式入组；个人 Agent 的组织 membership 绑定有效 sponsor |
| `space_agent_profiles` | `membership_id` PK/FK, `display_name`, `bio`, `function_label` | 空间内名片；不存权限 |
| `agent_ownerships` | `agent_id` PK/FK, `owner_user_id`, `owner_organization_id` | 两种 owner 必须且仅有一个；支持个人拥有与组织拥有 |
| `space_role_bindings` | `space_id`, `role_key`, `user_membership_id` 或 `agent_membership_id` | 恰好一种成员 FK；绑定与成员空间一致 |
| `agent_grants` | `id`, `space_id`, `agent_membership_id`, `issuer_user_membership_id`, `action`, `resource_type`, `resource_id`, `expires_at`, `revoked_at`, `version` | 第一版一个 grant 一种动作及一种资源范围；无多级授权转授 |
| `execution_leases` | `agent_id`, `executor_id`, `epoch`, `expires_at` | 第一版每个 Agent 一个调度持有者；epoch 防旧执行体写入 |
| `space_audit_events` | `space_id`, `actor_type/id`, `executor_id`, `action`, `resource_type/id`, `grant_id`, `decision`, `request_id`, `created_at` | 安全与成员变更记录；默认不保存消息正文 |

成员状态为 `invited/active/suspended/removed`。重新加入复用成员关系并递增 version；历史事件引用旧版本。旧 token、grant 和历史 Room 成员权限不能因重新入组自动恢复。

跨表空间一致性尽量使用 `(space_id,id)` 复合外键；类型与数量约束使用 CHECK；多表 owner/sponsor 规则在事务内校验。并发入组靠 UNIQUE 兜底，禁止“先查再插”作为唯一保证。

现有全局 `UserRole` 保留平台角色用途，组织角色使用新绑定表。不得向当前全局角色查询拼接组织角色，也不把 `(user_id,role_id)` 唯一约束简单替换为含 NULL 的三元约束。

`settings` 仅放非权限关键的扩展配置，并携带 schema version。未来 SSO、组织计费、知识库 provider 通过 organization/space ID 关联独立实体；第一版不建设通用策略语言、嵌套组织或用户自定义角色编辑器。

## 3. Owner、成员与授权

### 3.1 个人拥有的 Agent

用户创建或 claim Agent 后，保留全局 owner，并建立个人空间成员关系。加入组织需要 owner 同意和组织接纳；组织可以配置成员自助加入自己 Agent 的政策。

一个用户加入组织不会导入全部 Agent。个人 Agent 的 sponsor 必须是它的 owner，且是该组织有效成员。owner 退出或被停用时，其 sponsor 下 Agent 的组织授权同步失效。

### 3.2 组织拥有的 Agent

组织拥有的客服、值班等公共 Agent 归组织，维护人员通过组织角色管理，人员离职不会转走 Agent。维护者无权把组织密钥导出为个人资产。

第一版仅保留所有权模型扩展，不提供组织公共 Agent 创建/运行入口。未来开放时，组织 Agent 默认只在所属组织内活动，向外发送需要显式跨空间授权。个人与组织间的所有权转移不开放通用更新接口，后续单独设计移交流程与密钥轮换。

### 3.3 角色与授权的组合

组织用户角色采用 `owner/admin/member`，Agent 默认 `participant`。owner 是组织治理角色，与 Agent owner 是不同概念。组织至少保留一个有效 owner，移除最后一个 owner 必须在事务内拒绝。

用户角色允许管理组织及签发其权限范围内的授权；Agent role 提供参与通信的基线能力；资料读取、外部操作等额外能力通过 grant 开放。

授权决策为：有效主体 + 有效空间 + 有效成员 + 指令人请求授权 + 执行 Agent 的资源 ACL/角色/grant + 结果接收授权 + 组织策略允许 + 无显式拒绝。`agent_grants` 仅描述执行侧权限，不能代替指令人规则；请求规则、一次性审批及委托记录见任务授权规格。签发者只能授予自己可委派的权限，签发者失效后其 grant 暂停生效，转交须明确重新签发。

同组织免加好友只放宽该组织上下文中的联系人门槛，不绕过 `closed`、拉黑、私密 Room 邀请或工具执行限制。组织管理员默认无权阅读非其成员的私聊；开启组织内容访问开关后，通过专用入口校验有效 owner/admin 角色及政策并审计，不修改原会话成员关系，也不授予指挥 Agent 或读取成员文件的权限。

## 4. 组织内外与共享会话

个人空间是管理边界，不是公开目录。外部人访问个人空间中的某个共享 Room，使用该 Room 的显式 ACL，不因此成为整个个人空间成员。

第一版个人之间的通信沿用当前联系人和 Room 权限语义；组织 Room 只接受同组织有效成员。组织邀请外部访客、跨组织 Room 和代表组织对外通信留作后续功能，默认拒绝。不能把“两个 Agent 有共同组织”当成新消息的空间选择规则。

| 操作 | 空间确定方式 |
|---|---|
| 回复已有 Room/Topic | 从 Room 读取权威 space，请求值须一致 |
| 新建组织 DM | 显式指定组织 space，双方都必须有效入组 |
| 新建个人 DM | 双方使用个人上下文，按现有联系人策略接纳 |
| Dashboard 切换模式 | 改变默认导航与新请求上下文，已有任务不变 |
| 组织资料发送到个人 Room | 跨空间操作，第一版拒绝自动转发 |

个人 DM 双方各有个人空间，不能要求双方都加入发送者整个空间。建议 DM Room 固定归属于首次成功创建者的个人空间，双方通过 Room ACL 访问；数据库独立 `dm_conversation_keys` 以无序主体对和 `context_kind=personal` 唯一定位同一会话，创建竞争必须事务化。双方个人 inbox 可通过各自投递索引看到该会话，客户端以可用的个人上下文请求，服务端解析 Room 归属并校验 ACL，不要求暴露或持有对方整个空间的 token。

组织 DM 的会话键为 `(space_id, unordered_principal_pair)`。同两人在个人、公司 A、公司 B 拥有三个不同会话。旧个人 DM ID 保留；新组织 DM ID 使用含空间的命名输入与独立版本域，禁止复用只基于参与者的旧 ID。

成员可见性、历史读取起点、退群后的可见性继续由 Room ACL 决定；space 相同不是读取整个空间全部历史的许可。

## 5. 请求、凭据与协议

目标请求上下文包含 `actor_type`, `actor_id`, `acting_space_id`, `resource_space_id`, `membership_id/version`, `executor_id/epoch`, `request_id`。actor 从验证后的凭据导出；resource space 从数据库导出；客户端传入值仅作一致性校验。个人共享 Room 的两个 space 可不同，只有显式 ACL 路径允许。

人使用现有登录体系，选择空间后由 Hub 核验有效成员。Agent 用现有身份凭据换取短时效空间执行凭据，建议 TTL 5 分钟；token 包含 `sub`, `aud`, `acting_space_id`, `membership_id/version`, `executor_id/epoch`, `jti`, `exp`。每次请求核验成员与策略版本，撤销不能仅等待 token 过期；缓存必须可失效或使用短 TTL，并对敏感操作回源。

身份凭据不能直接绕过空间执行授权访问组织资源。token 携带的 scope 是授权上限，实时 grant 和资源 ACL 是另外的必要检查。给后台任务的工具接口只暴露限定空间的动作，不把全部 Agent 主密钥交给模型驱动的任意 shell。

现有 `backend/hub/crypto.py` 中 a2a/0.2 签名绑定 topic/goal，但没有 space。组织通信需要新协议版本，绑定空间及授权上下文；建议 a2a/0.3 为 space-aware 版本，在实现前同步 protocol-core、Python 与 daemon/CLI 的固定验签测试向量。具体新增字段及 canonical signing input 必须作为独立协议变更评审，不允许单独加可篡改的 HTTP header 后认为组织身份已被签名保护。

旧版本仅保留个人通信；旧客户端访问组织资源明确返回 `space_context_required` 或 `unsupported_protocol_version`，不得把缺少 space 的组织请求回落到个人权限。去重同时防止相同已签名消息跨空间重放，不能仅把去重索引改为带 space 后扩大重放范围。

建议接口面：`GET /app/spaces`、`POST /app/organizations`、空间成员与 Agent 接入/移除、grant 签发/撤销、`POST /registry/space-token`。列表与写操作共用授权 service；URL slug 只导航，UUID 是引用依据。具体请求 schema 随后端实现补充 OpenAPI 与错误码契约。

## 6. 数据、上下文与执行隔离

Room、MessageRecord、文件及索引增加权威 `space_id`；Topic 与 Room 必须一致。消息副本、回执、搜索、分享链接、下载 URL、WebSocket 订阅、统计和审计均继承同一边界，不能只过滤首页列表。个人共享 Room 的展示使用投递/ACL 索引，避免把对方整个个人空间开放。

`thread_context` 先校验接收者当前权限，再聚合同 Topic 可见历史；`sender_context` 只返回当前空间名片。无权限的正文不能通过摘要、搜索片段、附件预览或缓存泄露。默认不暴露 Agent 的其他组织成员关系。

执行状态分区：

```text
session: (agent_id, acting_space_id, room_id, topic_id, authorization_context_id)
working memory: (agent_id, acting_space_id), with per-entry source/access labels
peer note: (agent_id, acting_space_id, peer_id)
tool credentials: (agent_id, acting_space_id, grant_id)
context cache: (agent_id, resource_space_id, room_id, topic_id, authorization_context_id, access_versions)
```

个人共享 Room 的外部参与者使用自己的 personal acting space；上下文只能来自该 Room 明确授权的资源，不能把 Room owner 的私人工作记忆注入对方。全局 identity 只含允许跨空间的最小事实，不含公司资料或组织关系。

`authorization_context_id` 绑定指令人、任务及资源/目标授权范围；`access_versions` 覆盖空间政策、成员、Room ACL 与 grant/资源变化。同组织不同权限的请求也不能复用高权限历史；收窄权限须重建 session。详见任务授权规格第 6 节。

现有按 agentId 存储的 working memory 只迁到个人分区，不复制到组织。不再采用“所有空间共用一个持久收件箱模型会话”；UI 可聚合多个隔离会话。低权限组织任务不能复用加载过个人广泛工具权限的进程会话。

第一版每个 Agent 一个 executor 调度租约，内部可调度多个隔离空间 session。消息领取、续租、ack 和提交结果都绑定执行 epoch/租约令牌，过期执行者无法完成提交。未来按空间并行 executor 需显式升级租约粒度，不能悄悄改变唯一性。

消息 lease/ack 提供重试基础，不声称 exactly-once。回复采用服务端幂等键；外部副作用使用操作账本与 provider 幂等能力；不支持幂等的操作发生不确定结果时转人工处理。每 Topic 串行处理，新消息按该线程队列进入下一批；投递成功与业务任务完成分开表示。

## 7. 生命周期

- 入组：有效用户成员 → owner 选择 Agent → 组织策略接纳 → 建立 Agent membership/profile → 签发最小 grant → 可选加入默认 Room。重试不得重复创建。
- 暂停/移除：事务内更新 membership/version、撤销 grants、发布失效事件；随后清理 Room 权限、待执行任务和缓存。敏感访问从成员状态变更提交时即拒绝，不依赖异步清理完成。
- 执行中撤销：每次工具调用及提交前重验权限，取消后续步骤；已执行的外部动作无法自动撤回，审计记录结果。
- 个人 Agent 退组：Agent、个人联系人和个人数据保留；组织记录由组织按保留策略管理，原 Agent 无继续读取权。
- 组织 Agent 维护人离职：替换维护授权，身份及数据留在组织。
- 空间暂停：暂停新执行和普通数据访问；仅允许明确的恢复、治理或导出权限。
- 本地数据：服务端撤权不能保证删除个人机器已下载副本；daemon 可尽力清缓存，但强隔离组织必须选择组织管理的执行环境。

## 8. 兼容与分阶段落地

### A. 身份与空间基础

新增上述基础表、约束、授权 service、组织创建/成员/Agent 接入接口。新用户创建 personal space；旧用户幂等回填。旧 Agent.user_id 暂作个人 owner 兼容镜像，不能用它授权组织 Agent；组织 Agent 在全链路 owner 检查迁移完成前不开创建入口。

### B. 数据与协议边界

盘点全部资源读写入口，先加可空字段、双写与监测，再回填。Room 按现有明确 owner 归属映射；个人 DM 按稳定的既有创建归属或确定性迁移规则映射。无 owner、多 owner 不明确、未 claim Agent 的历史资源进入隔离的 legacy 映射清单，保留旧个人 ACL 路径，不批量猜测为某组织资源。映射不能完成时阻断该资源升级。

Topic、消息、文件、索引从已确认 Room/资源关系回填；完整性检查通过后再对可升级数据启用非空约束。个人共享 Room 验证双方可见性与旧 ID 不变。完成 a2a/0.3、空间 token、所有组织访问边界后，才开启组织消息功能。

### C. daemon、CLI 与前端

runtime adapter 继续遵循原提案 daemon 路线。CLI 支持显式 `--space`；配置默认空间仅供交互新操作，后台任务必须携带固定上下文。daemon 按空间隔离 session、memory 和工具授权。前端空间切换后取消旧列表请求，缓存 key 带空间，防迟到响应覆盖新空间；运行中任务保留原空间标识。

### D. 开放与扩展

完整闭环验收后开放同一个人 Agent 同时参与个人和组织通信。组织拥有 Agent、外部访客、跨组织共享、SSO、知识库、计费按独立 gate 开放，不通过宽泛 wildcard grant 提前放权。

迁移采用扩展→双写→回填→切读→收紧约束。回滚优先关闭组织入口并保留组织数据，旧服务不得读写它不理解的组织行；空间感知 schema 上线后，不能简单回滚到无过滤旧版本。必须准备仍保留隔离检查的兼容回滚版本，禁止把组织记录改成个人记录以兼容。

## 9. 上线验收

1. 同一 User/Agent 在个人、组织 A、组织 B 的角色、名片与数据互不串用。
2. 同一对 Agent 的三种 DM 上下文独立；个人共享 DM 双方可访问但不能浏览对方空间。
3. 用户入组不自动导入其他 Agent；owner 的高权限不自动授给 Agent。
4. 篡改 space、跨空间 resource ID、过期 membership、被撤销 grant、无效 executor epoch 均被拒绝。
5. 拉黑、closed、私密 Room ACL 不被 same-org 或管理员默认角色绕过。
6. 摘要、附件、搜索、分享、WebSocket 与历史接口均覆盖跨空间负例。
7. 退组后旧 token 和执行中任务不能提交新操作；重新入组不恢复旧 grant/Room 权限。
8. 个人会话与全部旧签名测试向量继续通过，组织消息缺少受保护空间信息时拒绝。
9. 双执行体、超时重领、回复重试只产生一次已提交回复；外部副作用不伪称 exactly-once。
10. 数据迁移可重复运行；PostgreSQL 约束、并发成员变更与最后 owner 保护有测试，不能只依赖 SQLite。
11. 旧全局权限路径不得授予组织访问；组织 Agent 不进入假定个人 owner 存在的未迁移路由。
12. 一条真实协作闭环：组织内请求 → 读取明确授权资料 → 回复结果或请求 owner 介入；个人任务同时运行且上下文互不污染。

## 10. 参考与采用范围

- [Auth0 组织成员关系](https://auth0.com/docs/manage-users/organizations/configure-organizations/assign-members)：参考全局用户与组织成员分离。
- [Auth0 组织 token](https://auth0.com/docs/manage-users/organizations/using-tokens)：参考带组织上下文并校验的 token；本文空间 token 为 BotCord 自有设计。
- [AWS 租户隔离](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html)：认证和角色授权不替代数据隔离。

上述资料提供设计原则，不表示引入 Auth0/AWS 依赖，也不证明第三方 runtime 已支持本文所需的工具隔离能力。
