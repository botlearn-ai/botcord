<!--
- [INPUT]: 依赖 cloud-agent-subscription-commercialization.md 的产品、成本和商业化草案，依赖 cloud-agent-technical-design.md 的技术决策，以及 BotCord 现有 Hub / frontend / wallet / daemon 架构。
- [OUTPUT]: 输出 Cloud Agent 订阅服务的工程拆解、阶段 gate、PR 顺序和 MVP 验收边界。
- [POS]: Cloud Agent 从方案进入实现前的工程实施计划，用于约束初期开发范围和拆分里程碑。
- [PROTOCOL]: 每完成一个 gate 后更新状态；若技术设计变化，先同步 cloud-agent-technical-design.md；若商业化方案或供应商策略变化，先同步 cloud-agent-subscription-commercialization.md。
-->

# BotCord Cloud Agent 订阅服务实施计划

> 状态: 方案确认，待实现
> 日期: 2026-05-20
> 父文档: `cloud-agent-subscription-commercialization.md`
> 技术设计: `cloud-agent-technical-design.md`
> 目标: 将 Cloud Agent 订阅服务拆成可验证、可回滚、可独立评审的工程增量。

## 1. 实施原则

Cloud Agent 是一个跨 backend、frontend、runtime、usage、安全和运营的大工程，不能一次性实现完整商业化形态。当前产品决策是先作为免费内测功能提供，Stripe 和公开付费售卖后置。

初期目标不是上线完整套餐，而是证明两个硬闭环:

- 执行闭环: 用户可以通过正式 API 创建 Cloud Agent，Hub 创建或复用 E2B sandbox，云端 daemon 连接 `/cloud/daemon/ws`，任务由 `deepseek-tui` 执行并回写 BotCord message。
- 计量闭环: 每次任务可以被预检查、预留额度、记录 usage、结算 Cloud Credits，并在超额时拦截。

所有开发都围绕这两个闭环推进。Stripe、Lite / Pro 多套餐、BYOK、Kimi fallback、Team workspace 和自动模型路由都后置。免费内测不等于无限使用，MVP 必须保留 usage ledger 和 quota gate 来控制 E2B 与模型成本。

## 2. MVP 边界

### 2.1 MVP 做什么

MVP 只支持免费内测 Cloud Agent:

```text
Cloud daemon: E2B sandbox 内运行 botcord-daemon
Cloud WS: /cloud/daemon/ws，同协议独立入口
Agent 托管: 一个 cloud daemon 可托管多个 Cloud Agent
模型: DeepSeek V4 Flash only
runtime: deepseek-tui
触发方式: 正式 run endpoint，后续接入房间消息触发
Shell: 允许在 E2B sandbox 内执行，必须有 wall time / tool call / output 限制
额度: 独立 Cloud Credits + sandbox active seconds 双限制
展示: Dashboard 显示 agent 状态、sandbox 状态、剩余额度、最近任务消耗
运营: feature flag 或内部 entitlement 放行
```

### 2.2 MVP 不做什么

MVP 暂不做:

- Stripe 公开售卖。
- Lite / Team 多套餐。
- 付费订阅门槛。
- DeepSeek Pro 自动升级。
- Kimi fallback。
- BYOK。
- 团队共享 workspace。
- marketplace。
- 无限常驻 sandbox。
- 不受限 shell / 网络访问。
- Hub-side DeepSeek HTTP task adapter。

## 3. 关键 Gate

### Gate 0: Cloud Runtime 可行性

目标: 在正式 API 架构下证明 E2B + cloud daemon + `deepseek-tui` 能稳定跑一个 headless 任务。

当前状态:

- 2026-05-20 已创建真实 E2B sandbox 验证默认 base 环境。
- 默认 E2B base 为 Debian 12 / glibc 2.36，DeepSeek TUI npm prebuilt binary 需要 GLIBC_2.38 / GLIBC_2.39，不能直接运行。
- 在默认 base 中 Cargo 源码构建因内存不足被 SIGKILL，不适合作为启动时 bootstrap 路径。
- 已构建 Ubuntu 24.04 / glibc 2.39 E2B template `botcord-deepseek-tui-ubuntu2404-dev2`，template ID `z0f20u29zdgx7cxnuzcu`。
- 已从该 template 创建 sandbox `i6hw70ih00yrc442p4ktb`，DeepSeek TUI v0.8.39 可执行。该 sandbox 后续已按手工操作 pause。
- `deepseek app-server --host 127.0.0.1 --port 8787` 只是环境探测产物；正式架构不让 Hub 直连 DeepSeek runtime server。
- 正式架构使用独立 Cloud daemon WS: E2B sandbox 内启动 `botcord-daemon`，daemon 使用 `/cloud/daemon/ws` 连接 Hub。
- DeepSeek TUI 由现有 daemon runtime adapter `deepseek-tui` 执行；该 adapter 内部使用 DeepSeek TUI 的本地 runtime API，而不是新增 Hub-side HTTP adapter。
- 当前缺 DeepSeek API key，`deepseek doctor` 显示 active provider key not configured；尚未完成真实 agent prompt 执行。

验收:

- 正式 API 可以创建 Cloud Agent 记录和 cloud daemon 记录。
- E2B sandbox 可以通过 provider 创建或 resume。
- Hub 可以注入 cloud daemon access token、daemon config、agent credentials 和 provider key。
- E2B 内 daemon 可以连上 Hub `/cloud/daemon/ws`。
- `runtime_snapshot` 可以写回 `daemon_instances` 或 cloud daemon 关联状态，且包含可用的 `deepseek-tui`。
- 可以通过 run endpoint 执行一条任务并拿到 message result。
- 可以记录 input tokens、output tokens 或等价 usage；如果 DeepSeek 暂时无法提供完整 token，必须记录替代估算和缺口。
- 可以 pause / resume，并确认 workspace 行为符合预期。
- 至少收集 20 个真实任务样本，记录 token、sandbox seconds、失败原因。

未通过时不进入 Dashboard 面向内测用户开放。

### Gate 1: 多 Agent 托管闭环

目标: 一个内部用户可以创建多个 Cloud Agent，并让它们共享同一个 cloud daemon / sandbox。

验收:

- `Agent.hosting_kind="cloud"` 可创建。
- `cloud_daemon_instances` 记录 sandbox / daemon lifecycle。
- `cloud_agent_instances` 记录 agent 到 cloud daemon 的绑定。
- 至少 2 个 Cloud Agent 可以托管在同一个 cloud daemon 上。
- `provision_agent` 可以对同一个 cloud daemon 多次下发并保持路由正确。
- Cloud Agent 创建失败可恢复或标记 failed。
- 删除一个 Cloud Agent 不影响同 daemon 上其他 Cloud Agent。

### Gate 2: 单次任务执行闭环

目标: Cloud Agent 可以通过 run endpoint 执行一次可观测任务。

验收:

- run 前执行 entitlement、quota、concurrency preflight。
- run 开始时 reservation credits 和 sandbox seconds。
- paused sandbox 可以 resume。
- 任务结果可以写回 BotCord message。
- shell 只在 E2B sandbox 内执行，受 wall time / tool call / output 限制。
- 任务失败时用户能看到明确结果。
- idle 后可以 pause sandbox。

### Gate 3: Usage 计量闭环

目标: 每次执行都有可追溯、幂等、可结算的 usage 记录。

验收:

- 任务结束时写入 `usage_events`。
- `usage_balances` 正确释放 reservation 并累计 used。
- 同一个 run 的重复回调不会重复扣费。
- 失败、超时、取消场景都能释放或结算 reservation。
- 超额用户不能启动新任务，也不会先启动 sandbox 再失败。

### Gate 4: 免费内测成本验证

目标: 用 10-30 个免费内测用户验证真实成本分布和额度墙有效性。

验收:

- Dashboard 能展示 Cloud Agent 状态和剩余额度。
- 可以导出或查询用户级 usage 报表。
- 普通用户月成本稳定低于免费内测预算线。
- 重度用户触发额度墙，不会继续产生无限 E2B 或模型成本。
- 产出是否进入公开付费、继续免费 beta 或改成 BYOK 的决策依据。

## 4. PR 拆解

### PR 1: Cloud Agent 数据模型

范围:

- 为 `Agent.hosting_kind` 增加 `cloud`。
- 新增 `cloud_daemon_instances`。
- 新增 `cloud_agent_instances`。
- 新增 `usage_events`。
- 新增 `usage_balances`。
- 若需要，在 `daemon_instances` 增加 `kind` / `source` 字段区分 local 与 cloud。
- 增加 migration 和 backend model 测试。

暂不做:

- Stripe subscription 表。
- 套餐管理 UI。
- 真实 E2B 调用。

验收:

- 现有 agent 行为不变。
- 默认 agent 仍是现有本地 / OpenClaw 模式。
- 新字段和表具备基本约束、索引和迁移测试。
- schema 支持一个 cloud daemon 托管多个 Cloud Agent。

### PR 2: Cloud Daemon WebSocket

范围:

- 新增 `/cloud/daemon/ws`。
- 新增 `cloud-daemon-access` token kind。
- 新增 cloud daemon registry。
- 复用 `/daemon/ws` 的 control frame schema、Hub 签名、ack 和 dispatch 逻辑。
- 支持 `hello`、`provision_agent`、`revoke_agent`、`list_runtimes`、`runtime_snapshot`、`pong`。
- 增加 WebSocket 鉴权、displacement、runtime snapshot 持久化测试。

暂不做:

- E2B 真实接入。
- Dashboard 创建入口。

验收:

- fake cloud daemon 可以连接 `/cloud/daemon/ws`。
- Hub 可以向 fake cloud daemon dispatch `list_runtimes` / `provision_agent`。
- cloud WS 与本地 `/daemon/ws` 的 registry 不互相污染。

### PR 3: CloudAgentService + Fake Provider

范围:

- 新增 `CloudAgentService`。
- 新增 `CloudDaemonProvider` 接口。
- 实现 `FakeCloudDaemonProvider`。
- 新增正式 API skeleton:
  - `POST /api/cloud-agents`
  - `GET /api/cloud-agents`
  - `GET /api/cloud-agents/{agent_id}`
  - `POST /api/cloud-agents/{agent_id}/pause`
  - `POST /api/cloud-agents/{agent_id}/resume`
  - `DELETE /api/cloud-agents/{agent_id}`
- API 层接 entitlement / feature flag。
- 增加 service 层和 API 层测试。

暂不做:

- 真实 E2B 调用。
- 真实任务执行。

验收:

- backend 可以在不依赖 E2B 的情况下测试 Cloud Agent 生命周期。
- 创建失败不会留下不可恢复的半成品。
- 删除 Cloud Agent 触发 fake cleanup。

### PR 4: E2BCloudDaemonProvider

范围:

- 实现 `E2BCloudDaemonProvider`。
- 使用真实 E2B 创建 / resume / pause / cleanup sandbox。
- 注入 cloud daemon access token、daemon config 和 DeepSeek provider key。
- 启动 `botcord-daemon start --foreground`，让它连接 Hub `/cloud/daemon/ws`。
- 验证 `runtime_snapshot` 中出现可用的 `deepseek-tui` runtime。
- 记录 sandbox id、template id、wall time、sandbox seconds 和失败信息。

暂不做:

- Dashboard 创建入口。
- Stripe / billing。

验收:

- Gate 0 通过或明确记录阻塞原因。
- provider 有可测试的错误映射和 cleanup 行为。

### PR 5: 创建与 Provisioning 闭环

范围:

- `POST /api/cloud-agents` 接真实 provider。
- 创建或复用 cloud daemon slot。
- 创建 `Agent(hosting_kind="cloud")`、SigningKey、agent token。
- 创建 `cloud_agent_instances`。
- 通过 `/cloud/daemon/ws` 发送 `provision_agent`。
- 等待 `agent_provisioned` / `runtime_snapshot`。
- 多 Cloud Agent 共用同一个 cloud daemon 的基础测试。

验收:

- Gate 1 通过。
- 未授权用户不能创建 Cloud Agent。
- 删除一个 Cloud Agent 不会清理同 daemon 上其他 Cloud Agent 的 workspace 或 credentials。

### PR 6: 单次任务执行

范围:

- 新增 `POST /api/cloud-agents/{agent_id}/runs`。
- run 前 quota preflight。
- reservation credits 和 sandbox seconds。
- resume sandbox。
- 通过现有 message / inbox 机制或最薄 run bridge 触发任务。
- 回写 BotCord message。
- idle 后 pause sandbox。
- 记录基础 run 状态和错误。

验收:

- Gate 2 通过。
- 任务失败时用户能看到明确结果。
- sandbox 不会无限常驻。

### PR 7: Usage Ledger 与 Quota Gate

范围:

- 实现 `usage_events` 幂等写入。
- 实现 `usage_balances` 预留和结算。
- 增加 Cloud Credits 计算函数。
- 记录 model tokens 和 sandbox seconds。
- 增加并发、重复回调、失败、超时和取消测试。
- 超额时阻止新任务。
- 接近预算时返回需要用户确认的状态。

验收:

- Gate 3 通过。
- 同一个 idempotency key 不会重复扣费。
- reservation 在成功、失败、超时场景下都能正确释放或结算。
- 预算不足时不会先执行再失败扣费。

### PR 8: Dashboard MVP

范围:

- Dashboard 增加 Cloud Agent 创建入口。
- 显示 agent status、sandbox status、剩余 credits、剩余 sandbox active time。
- 显示最近任务 usage。
- 支持手动 pause / delete。

验收:

- 内测用户可以不借助后台脚本完成 Cloud Agent 基础操作。
- UI 不承诺尚未实现的套餐、BYOK、fallback 或无限能力。

### PR 9: 后置付费商业化

范围:

- 保留为未来阶段，不进入当前免费 MVP。
- 若免费内测数据证明成本可控，再接入 checkout、webhook、billing portal。
- 新增真实 subscription 状态同步。
- 将免费 entitlement 迁移到 paid subscription 或 BYOK add-on。

前置:

- Gate 0、Gate 1、Gate 2、Gate 3 已通过。
- Gate 4 免费内测成本样本证明可商业化。

验收:

- 免费用户仍受 quota gate 限制。
- paid subscription active 后才能使用公开付费额度。
- canceled / past_due 用户被正确限制。
- webhook 重放不会重复发放额度。

## 5. 关键设计决策

已确认:

- `hosting_kind` 直接落在现有 `Agent` 表，并新增 `cloud` 枚举值。
- 新建 `/cloud/daemon/ws`，同协议但独立认证和 registry。
- 一个 cloud daemon / E2B sandbox 允许托管多个 Cloud Agent。
- Cloud Credits 独立，不复用现有 `COIN`。
- MVP 允许 E2B sandbox 内 shell，但必须有安全和预算边界。
- 直接做正式 API，不先做独立 prototype script。

PR 1 前已确认 (2026-05-20):

- ID prefix: `cloud_dm_<12 hex>` (cloud_daemon_instances) / `cloud_ag_<12 hex>` (cloud_agent_instances)。
- `daemon_instances` 新增 `kind` 字段 (`local | cloud`, default `local`)。
- 免费内测默认配额: 每用户每月 1000 Cloud Credits + 3600 sandbox seconds (可在 entitlement / feature flag 中调整)。
- run endpoint 通过写入现有 message / inbox 流程触发任务，不另建 run bridge。

PR 4 前已确认 (2026-05-20):

- DeepSeek provider key 通过 Hub env `DEEPSEEK_API_KEY` 注入 sandbox;完整 secret manager 留待生产硬化阶段。
- E2B template 默认 `botcord-deepseek-tui-ubuntu2404-dev2` (ID `z0f20u29zdgx7cxnuzcu`),通过 env `E2B_TEMPLATE_ID` 覆盖。
- sandbox 启动命令默认通过 `npx --package "$CLOUD_DAEMON_NPM_SPEC"` 运行 cloud daemon，避免使用模板中已过期的预装版本；设置 `CLOUD_DAEMON_NPM_SPEC=bundled` 时才使用镜像内置 `botcord-daemon`。注入 env: `BOTCORD_HUB_URL` / `BOTCORD_CLOUD_DAEMON_INSTANCE_ID` / `BOTCORD_DAEMON_INSTANCE_ID` / `BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN` / `DEEPSEEK_API_KEY`。

PR 6 前已确认 (2026-05-20):

- run endpoint 通过 MessageRecord (source_type=`cloud_agent_run`, envelope.type=`cloud_run`) 注入到 agent inbox,复用现有 message/inbox 路径,运行结果走标准回写流程。

仍待落实:

- Cloud trust policy 如何传给 daemon runtime adapter(daemon-side 修改,Hub 侧只透传 budget)。

进入 PR 9 前需要确认:

- Lite / Pro 的真实价格和额度。
- E2B Pro 是否需要购买。
- BYOK 是否作为重度用户分流入口。
- 免费功能是否继续保留，还是转为限时 trial。

## 6. 风险控制

成本风险:

- 默认 Flash only。
- 每任务强制 token、tool call、output 和 wall time budget。
- idle auto-pause。
- usage 先预留再执行。
- Cloud Credits 与 sandbox seconds 双限制。

安全风险:

- sandbox 只接收短期凭据。
- secret 不进日志。
- 删除 Cloud Agent 时吊销 token、删除 secret、清理 workspace。
- shell 只允许在 E2B sandbox 内执行。
- MVP 不开放不受限网络和 shell。

工程风险:

- provider 先 fake 后 E2B，避免测试依赖 E2B。
- billing 后置，先证明 usage 计量准确。
- cloud WS 与 local daemon WS 分 registry，避免生命周期混淆。
- 每个 gate 都可以独立停止或回滚。

## 7. 当前下一步

当前尚未完成 PR 1 / PR 2 / PR 3。下一步从数据模型和 cloud WS 开始:

```text
PR 1: Cloud Agent 数据模型
  - hosting_kind=cloud
  - cloud_daemon_instances
  - cloud_agent_instances
  - usage_events
  - usage_balances

PR 2: /cloud/daemon/ws
  - cloud-daemon-access token
  - cloud daemon registry
  - 复用 daemon control frame
```

完成 PR 1 和 PR 2 后，再进入正式 API skeleton 与 fake provider。
