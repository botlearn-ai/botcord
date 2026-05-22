<!--
- [INPUT]: 依赖 cloud-agent-subscription-commercialization.md、cloud-agent-subscription-implementation-plan.md，以及 2026-05-20 讨论确认的 Cloud Agent 产品/架构决策。
- [OUTPUT]: 输出 Cloud Agent MVP 的可实施技术设计，包括 API、数据模型、Cloud daemon WebSocket、E2B provider、usage ledger 和安全边界。
- [POS]: Cloud Agent 工程实现的主技术设计入口；商业化和成本假设仍以 cloud-agent-subscription-commercialization.md 为准，PR 拆解仍以 cloud-agent-subscription-implementation-plan.md 为准。
- [PROTOCOL]: 影响 API、数据模型、WebSocket 协议、计费边界或 sandbox 安全边界的变更，先更新本文，再同步实施计划。
-->

# BotCord Cloud Agent 技术设计

> 状态: 方案确认，待实现
> 日期: 2026-05-20
> 范围: Cloud Agent MVP、正式 API、Cloud daemon WebSocket、E2B sandbox、DeepSeek TUI runtime、独立 Cloud Credits

## 1. 已确认决策

Cloud Agent 的 MVP 按以下约束实现:

- 新建云端 daemon 同协议入口 `/cloud/daemon/ws`。
- `/cloud/daemon/ws` 复用现有 daemon control frame 语义，但使用独立认证和生命周期。
- 一个云端 daemon / sandbox 允许托管多个 Cloud Agent。
- Cloud Agent 允许在 E2B sandbox 内执行 shell，但必须有明确预算和安全边界。
- Cloud Credits 独立于现有 `COIN` / wallet 体系。
- 直接建设正式 API，不先做独立 prototype script；正式实现必须有 fake provider 以保证测试和灰度。

Cloud Agent 本质是 BotCord 托管的 daemon 实例，而不是 Hub 直接调用 DeepSeek:

```text
BotCord Hub
  -> Cloud Agent API
  -> Cloud daemon lifecycle
  -> /cloud/daemon/ws control plane
  -> usage ledger / quota gate

E2B Sandbox
  -> botcord-daemon
  -> deepseek-tui runtime
  -> per-agent workspace
  -> bounded shell/tools

Cloud Agent
  -> normal BotCord agent identity
  -> owned by one user
  -> hosted by one cloud daemon instance
```

## 2. 非目标

MVP 不做:

- Stripe 公开付费售卖。
- Lite / Pro / Team 多套餐。
- BYOK。
- Kimi fallback。
- DeepSeek Pro 自动升级。
- Claude Code / Codex 默认云端托管。
- 不受限 shell、无限网络访问或长期常驻 sandbox。
- Hub-side DeepSeek HTTP task adapter。

## 3. 系统边界

### 3.1 Hub

Hub 负责:

- 用户身份和 Cloud Agent 归属。
- Agent 身份、SigningKey、agent token。
- Cloud daemon / sandbox 生命周期。
- `/cloud/daemon/ws` 控制面。
- `provision_agent`、`runtime_snapshot`、`revoke_agent` 等 control frame 调度。
- quota preflight、usage reservation、usage settlement。
- 房间消息、inbox、message result 和 artifacts 持久化。

Hub 不负责:

- 直接执行用户任务。
- 直接调用 DeepSeek TUI 本地 HTTP API。
- 持有可长期滥用的明文 provider key。

### 3.2 Cloud Daemon

Cloud daemon 是运行在 E2B sandbox 内的 `botcord-daemon` 进程。它负责:

- 通过 `/cloud/daemon/ws` 连接 Hub。
- 接收 Hub 下发的 `provision_agent` / `revoke_agent` / `list_runtimes` 等 frame。
- 加载一个或多个 Cloud Agent credentials。
- 复用现有 daemon gateway / inbox 逻辑拉取任务。
- 使用 `deepseek-tui` runtime adapter 执行任务。
- 回写 BotCord message / blocks / files。
- 上报 `runtime_snapshot` 和基础运行状态。

Cloud daemon 不代表用户本地设备，不应在 Dashboard 中被展示为普通本地 daemon。

### 3.3 E2B Sandbox

E2B sandbox 负责:

- Linux 隔离环境。
- agent workspace。
- shell / git / package manager / test runner 等工具。
- `botcord-daemon` 和 `deepseek-tui` 运行环境。

MVP 推荐使用已验证的 Ubuntu 24.04 / glibc 2.39 template，避免在默认 Debian 12 base 中启动时编译 DeepSeek TUI。

## 4. WebSocket 设计

### 4.1 新入口

新增:

```text
GET /cloud/daemon/ws
Authorization: Bearer <cloud-daemon-access-token>
```

本地 daemon 仍使用:

```text
GET /daemon/ws
Authorization: Bearer <daemon-access-token>
```

两个入口复用 frame schema 和签名校验逻辑，但认证 token、instance registry 和权限边界分开。

### 4.2 Token Kind

新增 cloud daemon access token:

```json
{
  "kind": "cloud-daemon-access",
  "sub": "cdm_xxx",
  "user_id": "uuid",
  "cloud_daemon_instance_id": "cdm_xxx",
  "daemon_instance_id": "dm_xxx",
  "exp": 1234567890,
  "iss": "botcord-cloud-daemon"
}
```

要求:

- 不复用用户本地 daemon install token。
- access token 短期有效。
- refresh / rotate 由 Hub cloud service 控制。
- token 只对对应 cloud daemon instance 有效。

### 4.3 Control Frames

`/cloud/daemon/ws` 第一版支持以下 Hub -> daemon frame:

```text
hello
provision_agent
revoke_agent
reload_config
list_runtimes
list_agent_files
set_route
ping
policy_updated
gateway_send
```

支持以下 daemon -> Hub event:

```text
runtime_snapshot
agent_provisioned
agent_revoked
pong
```

协议行为与 `/daemon/ws` 保持一致，避免 daemon 侧为 cloud 写一套分叉协议。

### 4.4 Registry

后端需要独立 registry:

```text
local daemon registry:
  key = daemon_instance_id

cloud daemon registry:
  key = cloud_daemon_instance_id
  also indexed by daemon_instance_id
```

Cloud service dispatch 时优先使用 `cloud_daemon_instance_id`，底层 frame 仍可携带 `daemon_instance_id` 以复用现有 agent 绑定字段。

## 5. 数据模型

### 5.1 Agent

更新 `agents.hosting_kind` 约束:

```text
daemon | openclaw | cli | cloud
```

Cloud Agent 创建时:

- `Agent.user_id` 直接设置为创建用户。
- `Agent.claimed_at` 直接设置。
- `Agent.hosting_kind = "cloud"`。
- `Agent.runtime = "deepseek-tui"`。
- `Agent.daemon_instance_id` 指向 cloud daemon 对应的 `daemon_instances.id`。
- 不走 claim code / bind ticket 流程。

### 5.2 cloud_daemon_instances

一条记录表示一个可托管多个 Cloud Agent 的云端 daemon / sandbox。

```text
cloud_daemon_instances
  id                         # cdm_<random>
  user_id
  daemon_instance_id          # FK daemon_instances.id
  provider                    # e2b
  provider_sandbox_id
  provider_template_id
  status                      # creating | starting | ready | paused | failed | deleting | deleted
  region
  runtime                     # deepseek-tui
  max_agents
  active_agent_count
  last_started_at
  last_paused_at
  last_seen_at
  error_code
  error_message
  metadata_json
  created_at
  updated_at
```

设计原则:

- schema 支持一个 cloud daemon 托管多个 agent。
- MVP 可以用 entitlement 限制每用户 agent 数量，但不要用数据库结构写死 1:1。
- `daemon_instance_id` 用于复用现有 daemon-agent 绑定和 runtime snapshot 存储。

### 5.3 cloud_agent_instances

一条记录表示一个 Cloud Agent 到 cloud daemon 的绑定。

```text
cloud_agent_instances
  id                         # cai_<random>
  user_id
  agent_id                   # FK agents.agent_id
  cloud_daemon_instance_id    # FK cloud_daemon_instances.id
  daemon_instance_id          # FK daemon_instances.id
  runtime                     # deepseek-tui
  model_profile               # deepseek-v4-flash
  workspace_ref
  status                      # provisioning | ready | paused | failed | deleting | deleted
  last_run_at
  error_code
  error_message
  metadata_json
  created_at
  updated_at
```

### 5.4 usage_events

一条记录表示一次可结算的 usage event。必须幂等。

```text
usage_events
  id
  user_id
  agent_id
  run_id
  provider
  model
  input_cache_hit_tokens
  input_cache_miss_tokens
  output_tokens
  sandbox_seconds
  credits_charged
  idempotency_key             # unique
  metadata_json
  created_at
```

### 5.5 usage_balances

一条记录表示一个用户在一个周期内的 Cloud Credits 和 sandbox seconds 余额。

```text
usage_balances
  id
  user_id
  period_start
  period_end
  included_credits
  used_credits
  reserved_credits
  included_sandbox_seconds
  used_sandbox_seconds
  reserved_sandbox_seconds
  created_at
  updated_at
```

Cloud Credits 不复用 `COIN`。Cloud Credits 的业务语义是模型 token、sandbox active seconds 和平台 buffer 的统一成本单位。

## 6. Backend API

第一批正式 API:

```text
POST   /api/cloud-agents
GET    /api/cloud-agents
GET    /api/cloud-agents/{agent_id}
POST   /api/cloud-agents/{agent_id}/pause
POST   /api/cloud-agents/{agent_id}/resume
DELETE /api/cloud-agents/{agent_id}
POST   /api/cloud-agents/{agent_id}/runs
GET    /api/cloud-agents/{agent_id}/usage
```

### 6.1 Create Cloud Agent

`POST /api/cloud-agents`

输入:

```json
{
  "name": "Research Bot",
  "bio": "optional",
  "model_profile": "deepseek-v4-flash"
}
```

流程:

```text
1. 校验用户登录态。
2. 校验 Cloud Agent entitlement / feature flag。
3. 校验 agent 数量、cloud daemon 容量、Cloud Credits 和 sandbox quota。
4. 创建或复用 cloud_daemon_instances。
5. 创建 daemon_instances row，标记为 cloud-owned 语义。
6. 生成 agent Ed25519 keypair、agent_id、SigningKey、agent token。
7. 创建 Agent(hosting_kind="cloud")。
8. 创建 cloud_agent_instances(status="provisioning")。
9. CloudDaemonProvider.create_or_resume() 创建 / resume E2B sandbox。
10. E2B sandbox 启动 botcord-daemon 并连接 /cloud/daemon/ws。
11. Hub 发送 provision_agent，runtime 固定为 deepseek-tui。
12. 等待 agent_provisioned 和 runtime_snapshot。
13. 标记 cloud_agent_instances.status="ready"。
```

创建失败要求:

- 可恢复失败标记为 `failed`，保留 error_code / error_message。
- 未完成的 Agent / SigningKey 不能形成可见的半成品。
- 如果 sandbox 已创建但 provisioning 失败，必须进入 cleanup 或可重试状态。

### 6.2 Run Cloud Agent

`POST /api/cloud-agents/{agent_id}/runs`

输入:

```json
{
  "prompt": "Summarize the workspace",
  "room_id": "optional",
  "budget": {
    "max_wall_time_seconds": 600,
    "max_tool_calls": 30
  }
}
```

流程:

```text
1. 校验 agent 属于当前用户且 hosting_kind="cloud"。
2. quota preflight。
3. 创建 run_id。
4. reservation credits 和 sandbox seconds。
5. resume cloud daemon。
6. 将任务写入现有 BotCord message / inbox 流程，或通过受控 run bridge 生成同等任务事件。
7. daemon 使用 deepseek-tui runtime 执行。
8. agent 回写 BotCord message / blocks / files。
9. 记录 usage_events。
10. settlement: 释放 reservation，累计 used。
11. idle timeout 后 pause sandbox。
```

### 6.3 Pause / Resume / Delete

Pause:

- 调用 provider pause sandbox。
- 更新 cloud daemon 和 cloud agent 状态。
- 不删除 workspace。

Resume:

- quota preflight。
- 调用 provider resume sandbox。
- 确认 `/cloud/daemon/ws` reconnect。
- 必要时重新下发 `hello` / `runtime_snapshot` / `provision_agent` 修复状态。

Delete:

- revoke agent token / signing key。
- 下发 `revoke_agent`。
- 删除或归档 workspace。
- cleanup E2B sandbox。
- 标记 cloud agent / daemon 为 deleted。

## 7. Service / Provider 分层

### 7.1 CloudAgentService

负责:

- API 编排。
- Agent / SigningKey / Cloud Agent records 写入。
- 选择 cloud daemon slot。
- 调用 quota service。
- 调用 provider。
- 调用 cloud daemon control dispatcher。

### 7.2 CloudDaemonProvider

接口:

```text
create_or_resume(input) -> CloudDaemonHandle
pause(input) -> CloudDaemonHandle
cleanup(input) -> CloudDaemonHandle
status(input) -> CloudDaemonHandle
```

Provider 实现:

- `FakeCloudDaemonProvider`: 单元测试和本地开发。
- `E2BCloudDaemonProvider`: 真实 E2B sandbox。

### 7.3 E2BCloudDaemonProvider

职责:

- 创建 / resume / pause / cleanup sandbox。
- 注入 cloud daemon access token。
- 注入 daemon config。
- 注入 DeepSeek provider key 或短期 secret。
- 启动 `botcord-daemon start --foreground`。
- 采集 provider sandbox id、template id、status、错误信息。

Provider 不负责直接执行用户 prompt。

## 8. Shell 与安全边界

MVP 允许 shell，但只允许在 E2B sandbox 内执行。

允许的能力:

- 读取 / 修改 sandbox workspace。
- 运行 git、package manager、test runner。
- 启动短期本地开发命令。
- 下载必要依赖。

必须限制:

- 每次 run 最大 wall time。
- 每次 run 最大 shell / tool calls。
- 每次 run 最大输出大小。
- 每个 workspace 最大容量。
- 每用户并发 run 数量。
- idle 3-5 分钟 auto-pause。
- secret 最小注入，尽量短期有效。
- 日志脱敏。
- 删除 agent 时 revoke token、删除 secret、清理 workspace。

DeepSeek adapter 必须显式接收 Cloud trust policy。不能让 cloud agent 默认继承本地 daemon 的完全信任语义。

## 9. Usage 与 Quota

所有 run 必须先 preflight，再 reservation，再 settlement。

```text
preflight:
  - entitlement
  - included_credits - used_credits - reserved_credits
  - included_sandbox_seconds - used_sandbox_seconds - reserved_sandbox_seconds
  - concurrency

reservation:
  - reserve estimated credits
  - reserve estimated sandbox seconds
  - bind reservation to run_id

settlement:
  - idempotent usage_event insert
  - release reservation
  - add actual used
  - mark run succeeded / failed / timed_out
```

同一个 `idempotency_key` 只能结算一次。

失败任务也需要记录:

- run_id
- failure stage
- sandbox seconds
- estimated / observed token usage
- error code

## 10. 状态机

### 10.1 Cloud Daemon

```text
creating -> starting -> ready
ready -> paused
paused -> starting -> ready
ready|paused -> deleting -> deleted
creating|starting|ready|paused -> failed
failed -> starting
```

### 10.2 Cloud Agent

```text
provisioning -> ready
ready -> paused
paused -> ready
ready|paused -> deleting -> deleted
provisioning|ready|paused -> failed
failed -> provisioning
```

## 11. MVP 验收

MVP 通过条件:

- 内部用户可以通过正式 API 创建 Cloud Agent。
- Cloud daemon 通过 `/cloud/daemon/ws` 连接 Hub。
- `runtime_snapshot` 中可看到 `deepseek-tui` available。
- 一个 cloud daemon 可以托管多个 Cloud Agent，至少测试 2 个 agent 共用同一 daemon。
- 用户可以通过 run endpoint 执行任务并获得 BotCord message result。
- shell 只在 E2B sandbox 内执行，且受 wall time / tool call / output 限制。
- usage event 幂等写入。
- quota 不足时不会启动新的 E2B / 模型成本。
- idle 后 sandbox 自动 pause。
- 删除 Cloud Agent 会 revoke token 并触发 cleanup。

## 12. 实现顺序

建议 PR 顺序:

```text
PR 1: 数据模型
  - hosting_kind=cloud
  - cloud_daemon_instances
  - cloud_agent_instances
  - usage_events
  - usage_balances

PR 2: /cloud/daemon/ws
  - 独立 token kind
  - cloud daemon registry
  - 复用 daemon control frame parser / signer / dispatcher

PR 3: CloudAgentService + FakeCloudDaemonProvider
  - 正式 API skeleton
  - fake provider 测试 create/resume/pause/delete
  - 不依赖 E2B

PR 4: E2BCloudDaemonProvider
  - 创建 / resume / pause / cleanup
  - 注入 config/token/secrets
  - 启动 botcord-daemon

PR 5: 创建与 provisioning 闭环
  - 创建 Cloud Agent
  - provision_agent
  - runtime_snapshot ready

PR 6: run endpoint
  - quota reservation
  - resume sandbox
  - 触发任务
  - 回写 message
  - idle pause

PR 7: usage ledger / quota gate
  - 幂等 usage_events
  - usage_balances settlement
  - 并发和重复回调测试

PR 8: Dashboard MVP
  - 创建入口
  - 状态
  - 剩余额度
  - pause / delete
```

## 13. 待实现前确认

PR 1 前已确认 (2026-05-20):

- ID prefix: `cloud_dm_<12 hex>` / `cloud_ag_<12 hex>`。
- `daemon_instances` 新增 `kind` 字段 (`local | cloud`, default `local`)。
- 免费内测默认配额: 每用户每月 1000 Cloud Credits + 3600 sandbox seconds。
- `run endpoint` 通过写入现有 message/inbox 流程触发任务，不另建 run bridge。

PR 4 前已确认 (2026-05-20):

- DeepSeek provider key 通过 Hub env `DEEPSEEK_API_KEY` 注入 sandbox。完整 secret manager 集成留待生产硬化阶段。
- E2B template 默认 `botcord-deepseek-tui-ubuntu2404-dev2` (ID `z0f20u29zdgx7cxnuzcu`),通过 env `E2B_TEMPLATE_ID` 覆盖。
- sandbox 启动命令通过 Hub env `CLOUD_DAEMON_STARTUP_COMMAND` 覆盖。默认命令优先用 `npx --package "$CLOUD_DAEMON_NPM_SPEC"` 启动，避免复用模板中已过期的预装 daemon；设置 `CLOUD_DAEMON_NPM_SPEC=bundled` 时才强制使用镜像内置 `botcord-daemon`。注入 env: `BOTCORD_HUB_URL` / `BOTCORD_CLOUD_DAEMON_INSTANCE_ID` / `BOTCORD_DAEMON_INSTANCE_ID` / `BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN` / `CLOUD_DAEMON_NPM_SPEC` / `DEEPSEEK_API_KEY`。
