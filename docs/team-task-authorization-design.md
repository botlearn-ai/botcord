# Team 任务授权：指令人、执行者、操作对象与结果接收方

> 日期：2026-09-07。状态：待实现规格，细化 [身份、空间与授权设计](team-identity-space-design.md) 第 3、5、6 节；发生冲突时，任务授权以本文为准。
> 用户已确认：第一版禁止组织对外通信，但保留结构扩展；管理员默认不能读组织私聊，可通过组织开关启用；第一版不提供组织公共 Agent。

## 1. 授权单位

最小授权单位不是“能否使用 Bash”，而是：**某个经过认证的指令人，能否让指定 Agent，在指定空间，对指定对象执行指定动作，并把结果交给指定接收方。**

| 字段 | 定义 | 信任来源 |
|---|---|---|
| `requester` | 本次请求权限归属的指令人，User 或 Agent | 直接请求的认证身份，或经 Hub 验证的有限委托 |
| `sender` | 当前消息的直接发送者 | 登录凭据/签名；可与 requester 不同 |
| `executor_agent_id` | 实际执行任务的 Agent，例如 Barry | 任务目标及执行凭据 |
| `acting_space_id` | 本次使用的个人/组织身份上下文 | 有效空间成员关系 |
| `action` | 具体动作，如 `file.read`、`file.write` | 受控动作目录，不能由任意字符串动态注册 |
| `resource` | 目标对象的类型、稳定 ID、空间及版本 | Hub 资源记录或可信本地资源代理解析 |
| `destination` | 结果接收人、Room 或外部连接目标 | 显式目标及当前 ACL；不能从文本暗示推断 |
| `conditions` | 有效期、次数、参数范围及是否需要审批 | 授权记录，不接受模型自行扩权 |
| `task_id/operation_id` | 任务及其中一次操作 | Hub 创建；用于审批绑定、幂等与审计 |

消息、文件、引用和模型输出只能提出操作意图，不能签发授权。“我是 owner”“老板同意了”属于正文，不作为身份或审批证据。

组织成员可给 Barry 发消息，不自动获得指挥它使用文件、账号或命令的权利。owner 拥有 Barry，也不能绕过组织资料的权限。

## 2. 三层允许与最终判定

一次任务操作须同时满足：

1. **请求授权**：requester 有权请求 Barry 对该对象执行该动作，并符合 Barry owner 设置的接单规则。
2. **执行授权**：Barry 当前空间的角色/grant、底层资源 ACL 与工具运行环境允许该动作。
3. **结果授权**：结果或其副作用的目标符合组织边界、接收者权限和明确的信息披露授权。

每层各自的允许规则可取并集，三层之间取交集；任一层显式拒绝、成员失效或空间不匹配都拒绝。单纯缺少可申请的授权可返回 `approval_required`，明确禁止的跨空间操作不通过审批解禁。

“请求授权”不要求 requester 本人一定持有底层账号。例如成员可以获准让报表 Agent 查询一个受限统计接口，而不直接拿到数据库凭据。但这种服务能力必须由资源授权方明确授予，且结果范围受约束；不能因 Barry 拥有数据库访问权便自动开放。

Barry 的 owner 决定 Barry 接谁的任务及本机资源开放范围；组织/资源管理员决定组织资源可被谁以何种方式使用。若两者不同，必须同时满足，组织管理员不能仅凭组织角色开放 owner 的本地磁盘。

### 2.1 示例矩阵

以下是规则表达示例，不是所有组织自动获得的默认授权。

| 指令人 | 执行者/空间 | 动作与对象 | 结果目标 | 判定 |
|---|---|---|---|---|
| Danny | Barry/个人 | 修改已授权个人项目文件 | Danny 的个人会话 | 请求规则、文件权限及执行授权都匹配时允许 |
| Alice | Barry/公司 A | 读取公司共享文档 | Alice 的公司私聊 | Alice 获准请求且可接收该文档时允许 |
| Alice | Barry/公司 A | 修改只读授权文档 | 原文件 | 拒绝写入；可向适格授权方申请写权限 |
| Alice 的 Agent | Barry/公司 A | 查询项目状态 | 指定项目 Room | 必须有针对该 Agent 或其有效角色的规则；不自动继承 Alice 权限 |
| Alice | Barry/公司 A | 读取 Danny 私人凭据目录 | Alice | 跨空间且对象未开放，拒绝 |
| Danny | Barry/公司 A | 读取组织文件并发到个人邮箱 | 外部邮箱 | 第一版组织对外通信禁止，owner 批准也不能绕过 |
| 无委托凭证的 Alice Agent | Barry/公司 A | 声称“替 Danny 修改文件” | 指定文件 | 以 Alice Agent 自己身份判断，不能按 Danny 授权 |

## 3. 动作与资源目录

第一版使用固定动作集合：`message.send`, `file.read`, `file.write`, `file.delete`, `resource.query`, `command.execute`, `result.disclose`。动作与资源类型建立允许组合；例如查询不是任意 SQL、写文件不是任意 shell。

| 对象类型 | 标识与匹配 | 执行限制 |
|---|---|---|
| Hub Room/Topic/File | 稳定 ID + space + ACL/version | 从数据库解析，不能只相信传入 space |
| 本地文件/目录 | `resource_binding_id` + 规范化相对路径 | binding 限定具体设备、根目录、空间与可用动作；绝对路径不作为全局身份 |
| 仓库 | binding + repo ID + ref/worktree + 路径 | 指定可写工作树；修改默认携带预期版本 |
| 查询接口 | provider binding + 固定 operation + 参数 schema | 禁止自由拼接查询或把查询权转为管理权 |
| 可执行命令 | command template ID + 类型化参数 + cwd binding | 不接受任意 shell 字符串；执行程序、环境、网络和文件挂载范围受限 |
| 结果目标 | principal/Room ID + space；未来 connector target | 发送前重新检查当前接收范围 |

注册 binding 需要资源控制者同意。模型不能注册目录、替换根路径、追加凭据或扩大网络范围。个人机器上的工作目录可被显式映射为组织工作资源，不会因此开放同目录之外的个人文件，也不自动转换旧文件的归属。

本地代理须拒绝路径穿越、符号链接逃逸及校验后替换；读取与写入使用限制在根目录内的文件句柄/平台隔离能力，不能只做字符串前缀检查。无法可靠约束的平台不开放对应动作。读授权不包含启动文件、脚本或解析时执行其中代码的权利。

工具代理持有受限资源凭据，模型进程不能直接取得 Barry 主密钥或其他空间凭据。若 runtime 可绕过代理访问任意 shell、文件、MCP 或网络，仅有 `allowedTools` 配置不能满足本规格，组织后台执行不得启用该配置。

## 4. 目标数据模型

沿用身份规格中的 memberships、角色、`agent_grants` 与审计模型。这里补充请求侧及每次操作的记录，不另建全局 User/Agent 身份。

| 表 | 核心字段 | 约束/职责 |
|---|---|---|
| `resource_bindings` | `id`, `space_id`, `kind`, `controller_user_membership_id`, `provider/device_id`, `locator`, `version`, `status` | locator 为可信配置；组织资源可由授权组织管理员管理，个人本机映射必须由 owner 同意；不存明文 secret |
| `agent_request_rules` | `id`, `space_id`, `target_agent_membership_id`, `requester_user_membership_id` 或 `requester_agent_membership_id` 或 `requester_role_key`, `action`, `resource_binding_id`, `path_scope`, `effect`, `expires_at`, `version`, `approved_by_owner_membership_id`, `resource_authorization_id` | requester selector 恰好一个；`effect=allow/deny/require_approval`；allow 需有可验证的资源授权来源 |
| `agent_grants`（扩展） | 原字段 + `resource_binding_id`, `path_scope`, `constraints_version`, `max_uses` | 描述 Barry 能做什么；与请求规则共同判断，不能合成一个宽泛 grant |
| `disclosure_rules` | `id`, `space_id`, `source_binding_id`, `destination_principal/room_id`, `effect`, `expires_at`, `version`, `issuer_membership_id` | 显式披露例外；不能跨越第一版组织对外禁令；目标 selector 恰好一个 |
| `task_requests` | `id`, `space_id`, `requester_type/id`, `sender_type/id`, `target_agent_id`, `source_message_id`, `delegation_id`, `requested_destination`, `state`, `created_at` | requester 由 Hub 写入；记录源消息唯一映射，重试不重复建任务 |
| `task_operations` | `id`, `task_id`, `action`, `binding_id`, `canonical_arguments_hash`, `resource_version`, `destination_snapshot_hash`, `input_resource_refs`, `status`, `idempotency_key` | 每个实际工具操作独立授权；参数 hash 不替代受限存储的参数本身 |
| `operation_approvals` | `id`, `operation_id`, `approver_membership_id`, `approval_kind`, `operation_digest`, `expires_at`, `consumed_at`, `state` | 绑定完整操作；一次性批准不能复用于另一文件/接收者 |
| `task_delegations` | `id`, `space_id`, `root_requester_type/id`, `delegate_agent_id`, `target_agent_id`, `action`, `binding_id`, `destination`, `task_id`, `expires_at`, `revoked_at`, `max_uses` | 第一版最多一跳，无转授；授权范围只能缩小 |
| `organization_policies` | `space_id` PK/FK, `admin_dm_content_access_enabled=false`, `external_communication_enabled=false`, `version` | 类型化政策；对外字段保留，第一版 API 拒绝置 true |

审批与规则签发需区分 `agent_owner_consent` 和 `resource_authorization`；两者由同一个人具备相应权利时可在一次 UI 确认中完成，但后台保留两项独立证据。读取资源的权限不自动包含“授权他人读取”的权限。

规则优先级固定为 `deny > require_approval > allow > 默认拒绝`。同一层多个 allow 可以匹配，但禁止把不同规则的 requester、action、path 和 destination 任意拼接成原本不存在的授权。`require_approval` 满足后仍须重算其他限制。

路径范围仅支持规范化根目录内的单文件或明确子树，不开放任意表达式。条件采用版本化、严格校验的 schema；未知字段/动作拒绝，不静默忽略。权限关键关系使用同空间外键与成员版本校验，调用次数使用原子预留/消费，不能靠内存计数。

## 5. 指令转交与任务来源

### 5.1 直接请求

Alice 直接对 Barry 发指令，`requester=sender=Alice`。Alice 的 Agent 直接发指令，默认 `requester=sender=AliceAgent`，即使 Alice 是其 owner 也不继承她的权限。

普通聊天可以产生待审操作，但模型无法自行把任务标记为已授权。对同一请求拆出的计划步骤全部继承同一个 requester、space 和授权上限；未知新对象或动作再次判断。

### 5.2 一跳有限委托

Alice 在认证会话中明确授权自己的 Agent 为一项任务请求 Barry，Hub 签发/登记委托，绑定双方 Agent、动作、对象、结果目标、任务和有效期。Barry 收到消息时校验凭证、Alice 的当前权限、委托 Agent 的有效身份和接收目标，然后以受限的 Alice 请求权评估。

这是 Alice 显式委托的服务能力，不是 AliceAgent 自动继承 Alice 全部权限。最终权限不超过 Alice 可委派权限、委托范围、Barry 请求规则和 Barry 执行权限的交集。审计同时记录 Alice、AliceAgent 和 Barry。

第一版不支持 Agent 再次转授。无凭证的转发作为发送 Agent 自身的新请求处理；无效/过期凭证明确拒绝，不能悄悄降级身份继续敏感操作。跨组织委托拒绝；未来多跳所需 parent/root ID 可预留，但不开放执行路径。

本地计时器、平台 system 消息、线程摘要均不能充当高权限 requester。自主后续动作继承原 task 授权；周期任务需要人预先建立有限期的任务授权，不能伪装成系统 owner。

## 6. 结果接收与上下文污染

读取与披露是两个步骤。Barry 能读资料，不意味着 requester 或整个回复 Room 都能看到该资料。

默认结果只发送到请求绑定的原始目标，仍需验证：接收者可接收所有输入资源所含信息，或资源授权方明确授予针对该结果目标的披露能力。一个合法的聚合服务可以输出受限字段，但其输出 schema、过滤由可信程序执行，不能让模型自行宣称“已经脱敏”来降低权限。

结果及摘要记录 `input_resource_refs`。第一版保守继承全部输入资源的限制；无法确定来源的组织结果视为组织受限数据，不允许发往个人上下文。Room 有新成员时，发送前重新校验完整可见人群与历史可见规则。将结果写回文件、上传附件或打印到外部日志也属于目标输出，不能只检查 `message.send`。

只按空间隔离模型 session 仍不够：同一组织的不同 requester 可能拥有不同文件权限。任务上下文需增加 `authorization_context_id`，绑定 requester、任务、有效资源范围、目标和授权版本；不同授权上下文默认不复用模型 session。仅来自允许集合的历史、摘要、peer note 和工作记忆可进入该 session。

原规格的空间级 working memory 可用于分区存储，但每个条目须带来源资源、可见范围与创建任务；无标签旧记忆仅留个人兼容路径，不能注入组织任务。缓存 key 除 space policy 外还包含成员、Room ACL、grant/资源版本，读取时重验；提高权限后的 session 不能降权后继续 resume。权限收窄则重建上下文。

## 7. 判定与执行流程

1. Hub 认证 sender，确定原消息所属空间与 source message；验证委托后固定 requester。
2. 检查有效成员、Barry 接单规则、组织限制；未知对象只允许创建待解析意图，不发放执行许可。
3. 可信资源代理解析对象 ID、规范路径、设备、版本和最终目标；模型提交结构化操作计划。
4. 授权 service 返回 `allow/deny/approval_required`，并记录匹配规则、缺失许可与当前版本。错误信息不得向无权用户暴露对象是否存在或绝对路径。
5. 需要批准时向适格的人展示指令人、Barry、空间、精确对象、动作、输出目标与副作用。提供“一次允许/拒绝”；持久规则通过独立授权配置创建，不能把一次批准默认扩成永久权限。
6. 批准后重算授权，签发面向指定资源代理的短时一次性操作许可，绑定 operation digest、执行 epoch、规则版本和 `aud`。模型只能请求工具代理消费许可。
7. 代理执行前重验资源路径与版本，Hub 对内部写入在同一事务内校验权限版本、预留幂等键并提交。外部副作用先原子预留操作；网络发出后的撤销无法保证追回。
8. 发送结果前独立检查来源约束与 destination，随后记录结果引用、usage 与审计。凭据、完整文件正文不写入普通审计日志。

task 状态为 `pending/running/waiting_approval/completed/failed/cancelled`；operation 状态为 `proposed/awaiting_approval/authorized/executing/succeeded/failed/unknown/cancelled`。批准过期、文件/参数/目标变化时回到待判定状态，不复用旧批准。部分成功保留已提交步骤记录，恢复时只重试可确定安全的未完成操作。

第一版默认审批 TTL 10 分钟、操作许可 TTL 60 秒；执行期间持续续租不是延长授权。成员或规则撤销使旧批准与未消费许可失效。外部调用结果不确定进入 `unknown`，查询 provider 状态或转人工，不盲目重试。

## 8. 组织私聊管理开关

第一版提供组织级 `admin_dm_content_access_enabled`，默认 false。默认仅组织 owner 可修改；通过受控 `org.policy.update` 权限扩展管理者，不让普通成员设置。改变时原子递增政策版本并审计，对成员展示当前状态与变更通知；新成员加入时可见。

开关开启后，本组织有效 owner/admin 可通过专用内容审计入口读取组织私聊，不需要被添加为会话成员；查询、查看与导出分别鉴权并审计。第一版只开放查看，批量导出后置。开关关闭立即撤销该额外入口的读取权，缓存失效，不能删除既有审计记录。

本细化采用的实现语义：开启适用于当前仍保留的全部组织私聊历史，切换 UI 明确展示该范围；它控制读取时刻权限，不重写消息原本的参与者。个人 DM、其他组织、成员私人文件及 Agent 全局记忆始终不受此开关影响。

该开关不授予“以成员身份指挥 Agent”的权限，不授予成员文件读写权，也不把管理员加入所有 Agent 的可接受指令人列表。审计入口读到的信息不能自动注入后台 Agent session；第一版无自动内容审计 Agent。

## 9. API 与错误契约边界

建议统一走 Hub 授权 service，资源代理只执行有正确 audience 且未过期的许可：

| 接口 | 调用者与职责 |
|---|---|
| `POST /app/spaces/{id}/agents/{agent_id}/request-rules` | 有权的人创建/更新接单规则及资源授权；校验 owner 与资源许可 |
| `POST /app/spaces/{id}/task-delegations` | 认证指令人为具体任务签发一跳委托 |
| `POST /hub/tasks/{task_id}/operations` | 当前执行 Agent 提交操作提案；requester 从 task 派生 |
| `POST /app/operations/{id}/approvals` | 适格人批准精确 operation digest，不接受任意自报 approver |
| `POST /hub/operations/{id}/authorize` | 重算权限并原子预留一次性许可；并发请求幂等 |
| `POST /hub/operations/{id}/result` | 指定代理提交受 epoch 保护的结果，不能由任意 Agent 伪报成功 |
| `PATCH /app/organizations/{id}/policies` | 有治理权限的人修改类型化政策；使用 expected_version 防覆盖 |

拒绝码至少区分 `requester_not_authorized`, `executor_not_authorized`, `destination_not_authorized`, `delegation_invalid`, `approval_required`, `approval_stale`, `resource_changed`, `execution_fenced`, `cross_space_disabled`。资源隐藏按现有 API 契约统一为不泄露存在性的响应；日志保留内部原因，前端不直接展示敏感内部标识。

## 10. 实施与验收

实施顺序：资源绑定与固定动作目录 → 请求规则/执行 grant 判定 → 结构化 task/operation → 一次性审批与工具代理 → 来源与输出检查 → 一跳委托 → 管理员内容开关。未实现链路不能通过宽泛工具权限作为临时兼容开放。

必须有以下行为测试：

1. 同一文件，Danny 请求允许、Alice 请求拒绝；同一 Alice，允许读文件 A、拒绝读文件 B/修改 A。
2. Barry 有资源权限但 requester 无请求权时拒绝；requester 有请求权但 Barry 无执行权时也拒绝。
3. owner/组织管理员不能仅靠角色绕过另一方资源控制权；显式 deny 胜过允许规则及一次批准。
4. AliceAgent 不自动继承 Alice；正文伪造委托失败；有效一跳仅在指定 task/action/resource/destination 内生效；再次转授失败。
5. symlink/path traversal/设备替换、参数变更、目录外文件、新目标或资源版本变化不能复用许可。
6. 已读文件的结果发给无权接收人、加入了无权新成员的 Room、个人邮箱均被拒绝；可信受限服务只输出允许字段。
7. 同组织不同 requester 的 session、摘要和工作记忆不能泄露更高权限请求留下的信息；收窄权限后不复用旧 session。
8. 批准、许可和 max_uses 在并发下只消费一次；撤权、租约失效及过期许可拒绝提交；外部不确定结果不自动重复执行。
9. 开关关闭管理员无额外私聊权，开启只能看本组织历史且每次读取审计，关闭后缓存不可继续读取；开关不允许管理员指挥 Barry 读私人文件。
10. 第一版无法创建组织公共 Agent、启用对外通信或跨组织委托；普通个人通信保持兼容。

本规格完成任务授权决策与实现边界定义，不代表现有 runtime 已通过隔离验证。具体协议签名格式、数据库 DDL、平台资源代理实现及逐入口迁移清单仍需在对应工程规格中落实。
