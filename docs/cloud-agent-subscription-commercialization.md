<!--
- [INPUT]: 依赖 BotCord 现有 Hub / daemon / OpenClaw / wallet / subscription 架构，以及 2026-05-19 调研的 E2B、DeepSeek、Kimi API 公开价格。
- [OUTPUT]: 输出 BotCord Cloud Agent 订阅服务的技术方案、成本测算、商业化草稿与落地路线。
- [POS]: 共享产品与工程方案文档，用于评估“云端托管 agent + token 额度”是否进入实现阶段。
- [PROTOCOL]: 价格与供应商策略变化时更新“成本假设”章节；进入开发后拆分为具体 PRD、技术设计和里程碑 issue。
-->

# BotCord Cloud Agent 订阅服务方案草稿

> 状态: 草稿
> 日期: 2026-05-19
> 范围: 云端托管 agent、模型 token 额度、E2B 运行环境、基础商业化模型

## 1. 背景与目标

BotCord 当前更偏向让用户绑定本地 daemon、OpenClaw host 或已有 agent runtime。这个路径适合技术用户，但对没有本地 Codex、Claude Code、OpenClaw、daemon 环境的用户，首次使用门槛较高。

新增 Cloud Agent 订阅服务的目标是:

- 让用户不安装本地 agent 也能创建 BotCord agent。
- 由 BotCord 提供云端运行环境、基础模型额度和 workspace。
- 将高成本 agent 执行从“默认消耗”改为“可控额度 + 分层模型 + 按需升级”。
- 形成可商业化的订阅产品，而不是只依赖本地自带 runtime。

本方案不替代本地 daemon / OpenClaw 模式。Cloud Agent 是第三种托管形态:

```text
local daemon agent      用户本机运行，用户承担本地环境和模型配置
openclaw-hosted agent   用户自有 OpenClaw host 运行
cloud agent             BotCord 托管 sandbox + runtime + 模型额度
```

## 2. 核心结论

Cloud Agent 可以做，但不能默认用 Claude Code / Codex 这类高成本执行器。

推荐默认方案:

```text
E2B sandbox + DeepSeek TUI/runtime + DeepSeek V4 Flash 默认模型
高级任务升级到 DeepSeek V4 Pro
Kimi K2.6 作为可选高质量备选
Claude Code / Codex 只作为后续高级 add-on 或 BYOK 模式
```

主要原因:

- E2B sandbox 成本按秒计费，只要按需启动和 idle auto-pause，运行环境成本可控。
- token 成本才是 agent 任务的大头，尤其是长上下文、工具循环、代码任务、失败重试。
- DeepSeek V4 Flash 的单位 token 成本显著低于 Kimi K2.6 和 Claude/Codex，适合作为默认模型。
- DeepSeek V4 Pro 可作为复杂任务升级层，但需要注意 2026-05-31 后折扣结束的价格风险。

## 3. 产品形态

### 3.1 用户视角

用户购买订阅后，可以在 Dashboard 创建一个 Cloud Agent:

```text
Create Agent
  -> Local device / daemon
  -> OpenClaw host
  -> BotCord Cloud
```

Cloud Agent 默认具备:

- BotCord 身份与房间消息能力。
- 云端 Linux sandbox。
- 持久 workspace。
- DeepSeek TUI 或 BotCord 封装的 agent runtime。
- 月度 token / credit 额度。
- 月度 sandbox active hours。
- 基础文件上传与结果文件下载。

### 3.2 模型分层

默认策略:

```text
Flash mode
  - 默认模式
  - 低成本
  - 适合聊天、轻量代码修改、资料整理、工具调用

Pro mode
  - 用户显式开启或系统判断后请求确认
  - 适合复杂代码任务、长链推理、多步骤修复
  - 消耗更多 credits

Kimi fallback
  - 可选模型
  - 用于 DeepSeek 表现不稳、需要 Kimi 长上下文或特定任务表现时

BYOK
  - 用户自带 DeepSeek / Kimi / OpenAI / Anthropic key
  - BotCord 只收取 cloud runtime、协作和平台服务费
```

### 3.3 任务预算

每个任务必须有预算边界:

- 最大 input tokens。
- 最大 output / thinking tokens。
- 最大 tool call 轮数。
- 最大 sandbox wall time。
- 最大读取文件数量和文件大小。
- 最大并发任务数。

超过预算时暂停任务，向用户展示:

```text
任务已接近本次预算上限。
继续执行预计消耗 X credits，可选择继续、切换 Pro、或停止并查看当前结果。
```

## 4. 技术方案

### 4.1 架构边界

```text
BotCord Hub
  - 用户身份
  - agent 身份
  - 房间消息
  - 订阅与额度
  - usage ledger
  - cloud agent 生命周期
  - E2B sandbox 管理

Cloud Daemon Runtime Adapter
  - 创建 / 恢复 / 暂停 E2B sandbox
  - 注入 daemon config 与 cloud daemon access token
  - 启动 botcord-daemon
  - 复用 daemon control frame，但使用 /cloud/daemon/ws 独立入口
  - 通过 daemon provision_agent / room message 转发用户任务
  - 收集 runtime_snapshot、message result 与 artifacts
  - 上报 token usage

E2B Sandbox
  - 隔离 Linux 环境
  - workspace
  - git / shell / tools
  - BotCord daemon 进程
  - DeepSeek TUI runtime
```

Hub 是控制面，不直接执行用户任务，也不直接调用 DeepSeek TUI HTTP API。E2B sandbox 是执行面，里面运行现有 BotCord daemon；cloud daemon 通过 `/cloud/daemon/ws` 接 Hub 控制面，并复用 daemon 内已有的 `deepseek-tui` runtime adapter。`/cloud/daemon/ws` 与本地 `/daemon/ws` 使用同一 control frame 语义，但认证、registry 和生命周期独立。usage / entitlement 是所有执行的前置门禁。

### 4.2 数据模型草案

新增 `Agent.hosting_kind = "cloud"`。

MVP 先新增执行与计量表。数据模型支持一个 cloud daemon / sandbox 托管多个 Cloud Agent:

```text
cloud_daemon_instances
  id
  user_id
  daemon_instance_id
  provider
  provider_sandbox_id
  provider_template_id
  status
  region
  runtime
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

cloud_agent_instances
  id
  agent_id
  user_id
  cloud_daemon_instance_id
  daemon_instance_id
  runtime
  model_profile
  status
  workspace_ref
  last_run_at
  error_code
  error_message
  metadata_json
  created_at
  updated_at

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
  idempotency_key
  metadata_json
  created_at

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
```

付费商业化阶段再增加 `cloud_subscription_plans` 和 `user_cloud_subscriptions`，免费内测阶段先用 feature flag / 内部 entitlement + usage balance 控制访问和成本。

### 4.3 创建流程

```text
1. 用户点击 Create Cloud Agent
2. Hub 检查用户是否具备免费内测 entitlement / feature flag
3. Hub 检查 cloud agent 数量上限
4. Hub 创建 Agent(hosting_kind="cloud")
5. Hub 创建 cloud_agent_instances(status="creating")
6. Hub 生成 agent token 和 signing key
7. Hub 创建或复用 cloud_daemon_instances
8. Hub 创建或 resume E2B sandbox
9. Hub 注入 cloud daemon access token、daemon config、credentials 和 runtime config
10. sandbox 启动 botcord-daemon 并连接 `/cloud/daemon/ws`
11. Hub 通过 `provision_agent` 下发 agent credentials
12. Hub 等待 `agent_provisioned` 与 `runtime_snapshot`
13. Hub 标记 cloud_agent_instances(status="ready")
```

### 4.4 消息执行流程

```text
1. 房间消息进入 Hub
2. Hub 判断目标 agent hosting_kind="cloud"
3. Hub 检查免费 entitlement、额度、并发限制
4. Hub 预留本次 run 的 credits 和 sandbox seconds
5. Hub resume 或 create E2B sandbox
6. Hub 通过现有 message / inbox 机制或受控 run bridge 触发任务
7. cloud daemon 使用 `deepseek-tui` runtime adapter 执行任务
8. agent 流式或最终写回 BotCord message
9. Hub 记录 token usage 和 sandbox seconds
10. Hub 结算 usage，释放 reservation
11. idle timeout 后 pause sandbox
```

### 4.5 Sandbox 生命周期策略

不要给每个用户常驻 sandbox。

推荐策略:

```text
idle 3-5 分钟后 auto-pause
任务开始时 resume
长时间无使用后 snapshot / cleanup
订阅过期后 suspend
用户删除 agent 后清理 workspace 和 secrets
```

E2B pause 后不再计费，适合 Cloud Agent 的按需运行模型。

### 4.6 Secret 管理

Cloud Agent 需要处理:

- BotCord agent private key。
- Hub token。
- DeepSeek API key 或 provider key。
- 用户 BYOK key。
- 第三方 channel secrets。

原则:

- Hub DB 不存明文 secret。
- 使用 secret manager / KMS envelope encryption。
- sandbox 只接收短期可用的运行凭据。
- 日志必须脱敏。
- 删除 agent 时吊销 token、删除 secret、清理 workspace。

## 5. 成本假设

价格基准日期: 2026-05-19。

### 5.1 模型价格

| 模型 | Cache hit input | Cache miss input | Output | 备注 |
|---|---:|---:|---:|---|
| DeepSeek V4 Flash | `$0.0028/M` | `$0.14/M` | `$0.28/M` | 默认模型 |
| DeepSeek V4 Pro | `$0.003625/M` | `$0.435/M` | `$0.87/M` | 75% 折扣到 2026-05-31 |
| DeepSeek V4 Pro 原价 | `$0.0145/M` | `$1.74/M` | `$3.48/M` | 长期预算应考虑 |
| Kimi K2.6 | `$0.16/M` | `$0.95/M` | `$4.00/M` | 可选备选 |

来源:

- DeepSeek pricing: `https://api-docs.deepseek.com/quick_start/pricing`
- Kimi K2.6 pricing: `https://platform.kimi.ai/docs/pricing/chat-k26`

### 5.2 E2B 运行环境价格

E2B 按 sandbox running 秒数计费。默认 2 vCPU / 1 GiB 估算:

```text
CPU: 2 * $0.000014/s
RAM: 1 * $0.0000045/s
合计: $0.0000325/s
每小时: 约 $0.117/h
```

E2B Pro 固定费:

```text
$150/月 + usage
```

来源:

- E2B pricing: `https://e2b.dev/pricing`

## 6. 单次任务成本估算

以下只估算模型 token，不含 E2B。

| 任务规模 | Token 形态 | Flash | Pro 折扣期 | Pro 原价 | Kimi K2.6 |
|---|---|---:|---:|---:|---:|
| 小任务 | 40K 新输入 + 10K 输出 | `$0.01` | `$0.03` | `$0.10` | `$0.08` |
| 中任务 | 250K 新输入 + 50K 输出 | `$0.05` | `$0.15` | `$0.61` | `$0.45` |
| 大任务 | 1M 新输入 + 200K 输出 | `$0.20` | `$0.61` | `$2.44` | `$1.78` |
| 超大任务 | 3M 新输入 + 700K 输出 | `$0.62` | `$1.92` | `$7.66` | `$5.73` |

如果一次任务运行 30 分钟，默认 E2B 环境再加约:

```text
$0.117/h * 0.5h = $0.0585
```

## 7. 每用户月成本估算

假设:

- E2B 使用默认 2 vCPU / 1 GiB。
- sandbox 空闲自动 pause。
- 用户活跃时长只计算 sandbox running time。
- 不含 Stripe 费率、客服、日志、对象存储、监控、数据库、带宽等平台杂项。

| 使用强度 | 假设 | Flash + E2B | 80% Flash + 20% Pro 折扣 + E2B | Kimi + E2B |
|---|---|---:|---:|---:|
| 轻度 | 300 次轻交互/月，E2B 5h | `$0.70` | `$0.75` | `$1.93` |
| 普通 | 30 次普通 coding 任务/月，E2B 15h | `$2.23` | `$2.42` | `$6.39` |
| 重度 | 100 次较大 agent 任务/月，E2B 60h | `$10.55` | `$12.02` | `$42.87` |

若 DeepSeek V4 Pro 折扣结束，重度用户的 `80% Flash + 20% Pro + E2B` 估算约上升到 `$18.6/月`。

E2B Pro 固定费摊销:

| 付费用户数 | `$150/月` 摊销 |
|---:|---:|
| 10 | `$15/人/月` |
| 50 | `$3/人/月` |
| 100 | `$1.5/人/月` |
| 500 | `$0.3/人/月` |

早期用户少时，E2B Pro 固定费会显著影响毛利；用户超过 50-100 后，主要成本回到 token 和 sandbox active hours。

## 8. 商业化套餐草稿

### 8.1 Free / Trial

目标: 降低首次体验门槛，但严格控制成本。

```text
价格: $0
Cloud agents: 1 个试用 agent
模型: Flash only
额度: 少量 credits
Sandbox: 1-2 active hours / 月
限制: 无长期 workspace 或 workspace 小容量
用途: onboarding、demo、轻量问答
```

### 8.2 Cloud Lite

目标: 普通用户默认套餐。

```text
价格: $9/月
Cloud agents: 1
模型: DeepSeek V4 Flash
Pro credits: 无或极少
Sandbox: 20-30 active hours / 月
Workspace: 1-2 GiB
并发: 1
适合: 聊天、资料整理、轻量代码任务
```

成本预期:

```text
轻度用户: <$1/月
普通偏轻用户: $2-$4/月
毛利空间: 较好
```

### 8.3 Cloud Pro

目标: 主力付费套餐。

```text
价格: $19/月
Cloud agents: 1-2
模型: Flash 默认 + Pro 按需
Sandbox: 50-80 active hours / 月
Workspace: 5 GiB
并发: 1-2
适合: 常规 coding agent、自动化任务、团队内 bot
```

成本预期:

```text
普通用户: $2-$6/月
重度用户: $12-$19/月
需要额度墙，避免重度用户吃掉全部毛利
```

### 8.4 Cloud Team

目标: 小团队、重度用户、需要更高可靠性。

```text
价格: $49/月 起
Cloud agents: 3-5
模型: Flash + Pro + Kimi fallback
Sandbox: 150-250 active hours / 月
Workspace: 20 GiB
并发: 3+
支持: 优先队列、团队账单、共享 workspace 可选
```

成本预期:

```text
正常团队使用: $10-$25/月
高强度 coding: 需要额外 credits 或 BYOK
```

### 8.5 BYOK Add-on

目标: 控制平台模型风险，同时满足专业用户。

```text
价格: $5-$15/月 或包含在 Pro/Team
用户自带模型 API key
BotCord 只计 sandbox、协作、workspace 和平台服务
用户自行承担模型 token 账单
```

BYOK 是控制毛利波动的关键选项。

## 9. Credit 设计

不要直接把套餐描述成“多少 tokens”，因为不同模型价格、cache hit、output token 和折扣都会变化。

建议使用 BotCord Cloud Credits:

```text
credits = 模型成本折算 + sandbox 成本折算 + 平台 buffer
```

优点:

- 供应商涨价时不必频繁改套餐文案。
- 可以让 Flash、Pro、Kimi 使用同一额度池。
- 可以为高成本任务做预估和确认。

示例:

```text
1 credit = $0.01 成本基准
Lite: 500 credits/月
Pro: 1500 credits/月
Team: 5000 credits/月
```

实际兑换比例需要加 20%-50% buffer，用于 cache miss、重试、日志、对象存储、支付手续费和平台毛利。

## 10. 成本控制策略

必须内置以下控制:

- Sandbox idle auto-pause。
- 每任务 token budget。
- 每任务 tool call 上限。
- 每任务 wall time 上限。
- 每用户并发限制。
- Flash 默认，Pro 显式升级。
- 长上下文压缩，不默认塞完整历史。
- 文件检索按需读取，不允许 agent 无限制扫 repo。
- 对失败重试计费或限次。
- usage event 幂等写入，避免重复扣费。
- 月度额度低于阈值时提醒。
- 超额后暂停或要求购买 top-up。

## 11. MVP 范围

当前产品决策: Cloud Agent 先作为免费内测功能提供，Stripe 与公开付费售卖后置。第一阶段只做最小可用执行与成本控制闭环:

```text
1. 支持通过正式 API 创建 Cloud Agent
2. 一个 cloud daemon / E2B sandbox 可托管多个 Cloud Agent
3. E2B sandbox 按需创建 / resume / pause
4. /cloud/daemon/ws 同协议独立入口
5. DeepSeek V4 Flash 默认模型
6. usage ledger
7. 独立 Cloud Credits
8. Dashboard 显示剩余额度、sandbox 状态、任务消耗
9. feature flag 或内部 entitlement 放行免费内测用户
10. 超额暂停新任务
```

暂不做:

- Claude Code / Codex 默认托管。
- Stripe subscription checkout + billing portal。
- 多模型自动复杂路由。
- 团队共享 workspace。
- 大规模 marketplace。
- 无限长期常驻 agent。
- 不受限 shell / 网络访问。

## 12. 实施路线

### Phase 0: 正式 API 骨架与可测试控制面

- 新增数据模型。
- 新增 `/cloud/daemon/ws`。
- 新增 `CloudAgentService` 和 `FakeCloudDaemonProvider`。
- 通过正式 API 跑通 Cloud Agent lifecycle 测试，不依赖 E2B。

### Phase 1: 单用户 Cloud Agent

- 新增 `hosting_kind="cloud"`。
- 新增 `cloud_daemon_instances`。
- 新增 `cloud_agent_instances`。
- 新增 Cloud Agent 创建接口。
- 新增 E2B provider。
- 启动 E2B sandbox 内的 botcord-daemon，通过 `/cloud/daemon/ws` 连回 Hub。
- 支持 Dashboard 创建 Cloud Agent。
- 支持手动运行任务和消息回复。

### Phase 2: Usage 与免费额度

- 新增 `usage_events` 和 `usage_balances`。
- 新增免费 entitlement / feature flag。
- 实现 monthly free credit reset。
- 实现 quota preflight 和 usage settlement。

### Phase 3: 产品化

- 增加免费内测 Dashboard 入口。
- 增加 Pro mode 确认弹窗。
- 增加用量页面。
- 增加任务级成本预估。
- Stripe、Lite / Pro 套餐和 top-up credits 后置到付费商业化阶段。

### Phase 4: 扩展

- Kimi fallback。
- BYOK。
- 团队套餐。
- 更强 sandbox 隔离策略。
- 自建 sandbox 替代 E2B 的成本评估。

## 13. 风险与待验证问题

### 13.1 成本风险

- DeepSeek Pro 折扣到期后成本上升。
- output / thinking tokens 可能远高于预期。
- 重度用户可能在免费内测额度内跑大量任务。
- E2B Pro 早期固定费摊销较高。

缓解:

- Flash 默认。
- Pro 需要确认。
- 任务预算硬限制。
- 免费内测不承诺无限任务。
- BYOK 分流重度用户。

### 13.2 供应商风险

- DeepSeek / Kimi API 价格和可用性可能变化。
- E2B 并发、session 长度、区域、合规能力可能限制产品形态。
- DeepSeek TUI 的 headless 能力需要验证。

缓解:

- Runtime adapter 抽象模型供应商。
- usage 用 credits 而非固定 tokens 文案。
- 保留 Kimi / OpenAI / Anthropic / BYOK 后路。

### 13.3 安全风险

- Prompt injection 诱导 agent 读取 secret 或执行危险命令。
- sandbox 网络访问滥用。
- 用户文件和 workspace 泄露。
- agent 日志泄露敏感信息。

缓解:

- sandbox 隔离。
- secret 短期注入。
- egress allowlist。
- 日志脱敏。
- workspace ACL。
- 删除流程可审计。

## 14. 需要进一步决策

- DeepSeek TUI 是否长期作为正式 runtime，还是后续替换为 BotCord 自封装 runtime。
- Cloud Agent 的 shell / network allowlist 细则。
- 免费内测的实际 credits 和 sandbox active hours。
- 是否一开始就支持 BYOK。
- E2B Pro 何时购买，还是先用 Hobby 验证。
- run endpoint 是写入现有 message / inbox，还是增加最薄 run bridge 后再转成 message。

## 15. 当前建议

建议先做一个受限 MVP:

```text
Cloud Agent 免费内测
价格: $0
模型: DeepSeek V4 Flash 默认，V4 Pro 手动升级
运行: E2B sandbox，idle auto-pause
额度: credits + sandbox active hours 双限制
用户: 10-30 个内测用户
周期: 2-4 周
目标: 拿到真实任务成本分布
```

如果真实普通用户月成本稳定低于免费内测预算线，可以继续扩大免费 beta 或进入公开付费测试。如果重度用户成本快速接近预算上限，需要更强的额度墙、BYOK 或更高阶套餐。
