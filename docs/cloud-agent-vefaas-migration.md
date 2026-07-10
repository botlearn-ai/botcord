<!--
- [INPUT]: 依赖现有 Cloud Agent 技术设计、CloudDaemonProvider 抽象、E2B provider 实现，以及 veFaaS/腾讯云 AGSX 官方产品文档。
- [OUTPUT]: 对外提供 BotCord Cloud Agent 从 E2B 迁移到 veFaaS 的架构决策、实施阶段、验证 gate、灰度与回滚方案，并保留腾讯云 AGSX 作为备选 provider。
- [POS]: docs/ 下 Cloud Agent 沙箱基础设施迁移的实施依据，连接现有技术设计与后续 provider/image/运维 PR。
- [PROTOCOL]: provider 接口、云厂商兼容能力、镜像约束或迁移结论变化时更新本文，并同步检查 cloud-agent-technical-design.md、cloud-agent-subscription-implementation-plan.md 与 docs/README.md。
-->

# BotCord Cloud Agent 从 E2B 迁移至 veFaaS 方案

> 状态：方案草案，待 Gate 0 实测
>
> 更新日期：2026-07-10
>
> 范围：以火山引擎 veFaaS 为主迁移目标；包含腾讯云 Agent 沙箱服务 AGSX（官方文档中亦称 AGS / Agent Runtime）的备选方案对比。

## 1. 决策摘要

建议采用以下路线：

1. **主路径选择 veFaaS Cloud Sandbox**，继续使用 E2B Python SDK 作为兼容数据面，通过 `E2B_API_URL` 指向 veFaaS，并以 veFaaS 沙箱应用 ID 作为 template ID。
2. **先完成 BotCord 多 Provider 路由，再迁移新实例**。已有 `CloudDaemonInstance.provider` 字段，但当前生命周期调用仍使用全局 `CLOUD_AGENT_DEFAULT_PROVIDER`。必须先改为按实例 provider 路由，才能让 E2B、veFaaS 和未来 AGSX 安全共存。
3. **沿用当前“恢复后重新启动 daemon”的语义**。veFaaS 暂停只保存可写文件系统，不保存内存、进程和网络连接；BotCord 现有 E2B provider 本来就会在恢复后注入新 JWT 并重新启动 daemon，因此产品语义可以兼容。
4. **基础 Cloud Agent 不引入 AIO 镜像**。第一阶段使用 BotCord 自定义镜像加 Envd sidecar；浏览器、桌面或 Jupyter 能力以后按 agent 类型单独引入 AIO Sandbox，避免扩大基础镜像和攻击面。
5. **保留腾讯云 AGSX 为第二 Provider**。AGSX 在多地域、进程级快照、VPC/NetworkPolicy 和自动暂停方面更强，但 2 vCPU / 1 GiB 的公开计算单价约为 veFaaS 的 2.05 倍，且当前 BotCord 镜像需要适配腾讯 S6/Envd 基础镜像。

最终目标不是把代码中的 `e2b` 字符串替换成 `vefaas`，而是形成以下稳定边界：

```text
CloudAgentService
        │
        ▼
ProviderRouter ── CloudDaemonInstance.provider
        │
        ├── e2b          存量与回滚
        ├── vefaas       主路径
        └── tencent_ags  可选第二云
```

## 2. 目标与非目标

### 2.1 目标

- 在不改变 Cloud Agent 对用户可见语义的前提下，让新 Cloud Agent 运行在 veFaaS 沙箱。
- 保持“一用户一个 cloud daemon、一个 daemon 承载多个 agent”的现有资源模型。
- 支持创建、连接、后台命令、暂停、恢复、状态查询和销毁。
- 暂停后保留 `~/.botcord`、workspace、会话和快照文件，恢复时使用新的短期凭证重新连接 Hub。
- 迁移期间允许 E2B 与 veFaaS 实例并存，并能按 cohort 灰度、快速回滚。
- Provider 边界为以后接入 AGSX 或其他 E2B-compatible sandbox 留出空间。

### 2.2 非目标

- 第一阶段不迁移正在运行的 E2B 实例，也不在原记录上直接改写 provider。
- 第一阶段不承诺浏览器自动化、桌面 GUI、Jupyter 或 MCP AIO 能力。
- 不假定不同厂商的暂停/恢复、超时、快照和状态机完全等价。
- 不把云厂商密钥写入数据库、镜像、日志或仓库。

## 3. 当前实现基线

### 3.1 BotCord 已有抽象

[`CloudDaemonProvider`](../backend/hub/services/cloud_daemon_provider.py) 已提供足够的最小生命周期接口：

- `create_or_resume`
- `pause`
- `cleanup`
- `status`

[`E2BCloudDaemonProvider`](../backend/hub/services/cloud_daemon_provider_e2b.py) 当前使用的 E2B SDK 调用面很小：

- `AsyncSandbox.create(template, timeout, envs, lifecycle)`
- `AsyncSandbox.connect(sandbox_id, timeout)`
- `sandbox.commands.run(command, background=True, envs=env, timeout=0)`
- `AsyncSandbox.pause(sandbox_id)`
- `sandbox.kill()`

这使 veFaaS 的 E2B 兼容接口具备较低的接入成本；迁移风险主要不在命令和文件 API，而在生命周期语义、异步状态和镜像启动方式。

### 3.2 必须先修复的路由问题

[`CloudDaemonInstance`](../backend/hub/models.py) 已保存 `provider`、`provider_sandbox_id`、`provider_template_id` 和 `region`，通常不需要新增数据库字段。但 [`CloudAgentService`](../backend/hub/services/cloud_agent.py) 当前通过一个全局 `_get_provider()` 执行所有生命周期操作，分配实例时也没有显式区分“沿用已有实例 provider”和“为新实例选择默认 provider”。

如果直接把 `CLOUD_AGENT_DEFAULT_PROVIDER` 从 `e2b` 改为 `vefaas`，已有 E2B 行会被交给 veFaaS provider 执行连接、暂停或清理，存在误判、孤儿实例和错误计费风险。

迁移前必须实现：

- 创建新实例：仅在用户没有 active daemon 时使用当前默认 provider，并将其稳定写入记录。
- 操作已有实例：严格根据 `CloudDaemonInstance.provider` 解析 provider。
- 分配已有 daemon：provider 对用户保持粘性；只要 active daemon 存在，就继续复用其 provider，不因全局默认值变化而另建实例。
- 测试注入的 fake provider：保留现有 override 能力。
- 未知 provider：明确失败并告警，不回落到全局默认值。

当前数据库唯一索引只允许每个用户存在一个 active daemon，且 `paused` 也属于 active 状态。因此 provider 灰度只影响尚无 active daemon 的用户；已有用户若要迁移，必须先显式导出/确认持久数据并退役旧实例，再创建新 provider 实例，不能让两个 active provider 并行。

## 4. veFaaS 与腾讯云 AGSX 对比

下表以 BotCord 基础 Cloud Agent 为场景，不把浏览器或桌面 AIO 作为必选能力。

| 维度 | 火山引擎 veFaaS Cloud Sandbox | 腾讯云 AGSX / AGS | 对 BotCord 的影响 |
| --- | --- | --- | --- |
| E2B 兼容 | 官方提供 E2B 兼容地址；修改 API URL、API key 和 template 即可接入 | 官方提供 E2B domain；修改 domain 和 API key 即可接入 | 两者都可复用命令、文件和连接调用面 |
| 创建兼容度 | 官方兼容表将 create 标为“部分支持”，需实测 `lifecycle`、timeout 和 env | 创建、命令、文件和 kill 有 E2B SDK 示例 | 两者都必须做 Gate 0，不按宣传语直接上线 |
| 后台命令 | `commands.run` 兼容 | 明确支持 `background=True` 及进程查询/终止 | 均满足 daemon 后台启动需求 |
| 暂停/恢复 | 暂停释放 CPU/内存；保存最新可写文件系统快照；不保存进程、内存和连接 | 官方强调进程级快照；暂停/恢复为异步状态机 | BotCord 会重新拉起 daemon；AGSX 的进程保留是额外能力，不应成为正确性依赖 |
| 暂停 API | E2B 兼容文档明确列出 pause/resume | Cloud API 明确支持；公开 E2B SDK 文档没有明确承诺 pause 兼容 | AGSX provider 应预留原生 Cloud API 控制面 |
| 镜像 | 任意自定义镜像可通过 Envd sidecar 注入 E2B 能力；现有镜像改造较小 | 为使用 E2B/Envd 能力需基于腾讯 code sandbox 镜像；快照启动要求 `USER root`、`WORKDIR /`、S6 | veFaaS 更适合快速迁移；AGSX 的镜像改造和安全复核量更大 |
| 地域 | 当前 E2B 兼容和 AIO 文档仅列华北 2（北京） | API 文档列北京、上海、广州 | 有华东/华南地域或容灾要求时 AGSX 更占优 |
| 网络 | 默认共享公网出口，可配 VPC/NAT | PUBLIC、SANDBOX、VPC；支持 NetworkPolicy 和安全组 | AGSX 的出网白名单能力更明确；两者都需验证到 Hub/npm/模型 API 的出口 |
| 持久存储 | 暂停快照保存实例文件系统 | 快照外还可挂载 CFS，并可做实例路径隔离 | 长期大工作区可优先评估 AGSX+CFS；MVP 使用快照即可 |
| 自动空闲治理 | BotCord 自己的 idle sweep 调 pause | 官方产品动态包含自动暂停、自动恢复和 Keepalive | 第一阶段仍由 Hub 统一治理，避免双重策略冲突 |
| 基础沙箱规格 | 文档支持自定义 CPU/内存 | Code Interpreter 最低 1 CPU / 1 GiB；AIO 为更高规格 | 基础 Cloud Agent 无需 AIO 规格 |
| 2 vCPU / 1 GiB 公开计算价 | 约 ¥0.32832/小时 | 约 ¥0.6732/小时，前 15 GiB 系统盘当前免费 | AGSX 约为 veFaaS 的 2.05 倍，未计网络和折扣 |
| 当前产品状态风险 | E2B 兼容、pause/resume 为邀测能力，需确认账号白名单 | 部分文档仍出现公测/内测措辞差异，需确认账号、地域和计费状态 | 两者商务准入都应是上线 gate |

### 4.1 推荐排序

**选择 veFaaS 的条件：**

- 已取得北京地域 Cloud Sandbox、E2B 兼容和暂停/恢复白名单。
- 主要目标是降低计算成本并快速复用当前 E2B provider 与镜像。
- 单地域可以满足当前 Cloud Agent MVP 的可用性要求。

**优先选择或补充 AGSX 的条件：**

- 需要北京、上海、广州多地域部署或地域级容灾。
- 需要更明确的 VPC、NetworkPolicy、安全组和持久 CFS 能力。
- 进程级快照、自动暂停/恢复带来的恢复速度收益足以覆盖更高成本和镜像改造。
- veFaaS 邀测资格、容量或 SLA 无法满足上线要求。

## 5. 目标架构

### 5.1 Provider 身份与传输协议分离

数据库中的 provider 应表示资源归属，而不是所用 SDK：

- `e2b`
- `vefaas`
- `tencent_ags`

veFaaS 和 AGSX 即使都使用 E2B SDK，也不能把记录写成 `e2b`，否则无法选择正确 endpoint、凭证、状态映射和清理逻辑。

建议新增：

```python
def _get_provider_for(self, cdi: CloudDaemonInstance) -> CloudDaemonProvider:
    if self._provider is not None:  # tests / explicit override
        return self._provider
    return get_provider(cdi.provider)
```

新实例继续由 `CLOUD_AGENT_DEFAULT_PROVIDER` 决定；已有实例的所有 `create_or_resume`、`pause`、`cleanup` 和 `status` 都必须使用 `_get_provider_for(cdi)`。

### 5.2 控制面和数据面

```text
Hub lifecycle request
    │
    ├─ provider = vefaas
    │      ├─ 控制面：E2B-compatible API（必要时原生 veFaaS API）
    │      └─ 数据面：Envd commands/files/connect
    │
    └─ provider = tencent_ags
           ├─ 控制面：腾讯云 Cloud API（pause/resume/status 兜底）
           └─ 数据面：E2B-compatible domain / Envd
```

veFaaS 第一阶段可以全部通过 E2B SDK 完成。AGSX 的公开文档未明确确认 E2B SDK 的 pause/resume 兼容性，因此生产设计应允许使用腾讯 Cloud API 执行暂停、恢复和状态轮询；Gate 0 还需确认 E2B 返回的 sandbox ID 与 Cloud API 的实例 ID 是否可直接互通。

### 5.3 恢复语义

BotCord 不应依赖任何 provider 保存正在运行的 daemon 进程。统一恢复流程为：

1. 恢复或连接 provider sandbox。
2. 等待实例达到可执行命令的稳定状态。
3. 从 Hub 获取新的短期 daemon JWT 和 agent provisioning payload。
4. 注入 `BOTCORD_*`、运行时凭据和模型环境变量。
5. 启动 `botcord-daemon start --foreground` 后台命令。
6. 等待 daemon WebSocket hello 和 agent ready。
7. 成功后再把数据库状态更新为 `ready`。

即使 AGSX 保留了进程，也执行 daemon singleton/restart 流程，以避免旧 JWT、旧 Hub 地址和重复连接。

## 6. veFaaS 迁移设计

### 6.1 配置

建议增加独立配置，不复用生产 E2B 密钥变量：

```env
CLOUD_AGENT_DEFAULT_PROVIDER=vefaas

VEFAAS_E2B_API_URL=https://api.vefaas-e2b.sandbox-cn-beijing.volcapig.com
VEFAAS_E2B_API_KEY=***
VEFAAS_SANDBOX_APPLICATION_ID=***
VEFAAS_REGION=cn-beijing
VEFAAS_SANDBOX_TIMEOUT_SECONDS=1800
```

约束：

- `VEFAAS_SANDBOX_APPLICATION_ID` 是 veFaaS 沙箱应用 ID，在 E2B 调用中作为 template ID。
- provider client 显式传 `api_url`，不在进程级全局修改 `E2B_API_URL`，避免同一 Hub 进程无法同时操作 E2B 和 veFaaS。
- 密钥只从 Secret Manager / 部署环境注入，日志中只保留 provider、region 和脱敏后的 sandbox ID。
- 当前 E2B provider 的公用 SDK 逻辑可抽成内部 transport，但 `vefaas` 必须保留独立错误映射和状态处理。

### 6.2 镜像

以 [`e2b/e2b.Dockerfile`](../e2b/e2b.Dockerfile) 为基础构建 veFaaS 镜像：

1. 将镜像推送到火山引擎 CR。
2. 创建 veFaaS 沙箱应用，并按官方方式注入 Envd sidecar。
3. 保留非 root `agent` 用户、`/home/agent`、Node/npm、BotCord daemon 以及 runtime 依赖。
4. 不依赖镜像 ENTRYPOINT 自动完成注册；Hub 每次 create/resume 都显式执行 startup command。
5. 对 npm 包采用固定版本或 digest。现有 `@botcord/daemon@latest` 便于热更新，但不利于可重复恢复，正式灰度前应记录并逐步切换为版本化配置。
6. 镜像中不得包含 Hub JWT、用户模型密钥、BotCord identity 或云厂商密钥。

### 6.3 生命周期映射

| BotCord 动作 | veFaaS 动作 | 必须处理的差异 |
| --- | --- | --- |
| 首次启动 | E2B-compatible create | 验证 `lifecycle.on_timeout=pause` 是否被接受；不支持时由 Hub idle sweep 主动 pause |
| 已运行实例恢复 | connect + get info | connect 失败时先查真实状态，不立即创建新实例 |
| 已暂停实例恢复 | resume，轮询到 running，再 connect | resume 不是瞬时完成；禁止在 `resuming` 时启动 daemon |
| daemon 启动 | `commands.run(..., background=True, envs=..., timeout=0)` | 验证后台进程、环境变量和无限命令 timeout 行为 |
| 空闲暂停 | pause，轮询到 paused | pause 为异步；数据库不能提前标记最终 paused |
| 销毁 | kill/delete | 404/not found 按幂等成功处理 |
| 状态检查 | get info/status | provider 状态统一映射为 creating/ready/pausing/paused/resuming/failed/missing |

`CloudDaemonProvider` 的公共返回状态可以暂不扩展，但 provider 内部必须轮询到稳定态或抛出明确的超时异常；原始 provider state 应进入指标，并可写入现有 `metadata_json` 供排障使用，无需因此新增状态枚举。

### 6.4 文件和会话

veFaaS 暂停保留文件系统快照，但不保留内存、进程和连接。需要验证并监控：

- `BOTCORD_HOME` 下 identity、sessions、snapshots 和 inbox 数据。
- runtime 工作目录及用户生成文件。
- 暂停时正在写入的 SQLite/JSON/NDJSON 文件是否需要 flush 或 graceful shutdown。
- 恢复后 daemon 是否正确重建 WebSocket、runtime 子进程和 agent 状态。
- 快照生成尚未完成时立即 resume 的一致性行为。

建议 pause 前先给 daemon 一个短暂的 graceful stop/flush 窗口；超时后再强制 pause。不能把进程内存视为持久状态。

## 7. 腾讯云 AGSX 备选设计

### 7.1 Provider 配置建议

```env
CLOUD_AGENT_DEFAULT_PROVIDER=tencent_ags

TENCENT_AGS_E2B_DOMAIN=ap-guangzhou.tencentags.com
TENCENT_AGS_E2B_API_KEY=***
TENCENT_AGS_SANDBOX_TOOL=***
TENCENT_AGS_REGION=ap-guangzhou

# 仅原生 Cloud API 控制面需要
TENCENTCLOUD_SECRET_ID=***
TENCENTCLOUD_SECRET_KEY=***
```

E2B domain 文档给的是不含协议的域名，AGSX client 应使用 SDK 的 `domain` 配置，而不是照搬 veFaaS 的 `api_url` 配置。

### 7.2 镜像改造差异

为了使用 E2B/Code Interpreter 能力，腾讯官方建议从其 code sandbox 基础镜像派生。快照启动还有以下关键约束：

- Dockerfile 使用 `USER root`。
- `WORKDIR /`。
- 入口由 S6 `/init` 管理，恢复快照时 Docker command/args 不会重新执行。
- 需要 `S6_KEEP_ENV=1`，业务环境变量通过 Tool/API 注入，不能依赖 Dockerfile `ENV` 传递动态凭证。
- Envd 相关端口包括 49983，run_code 端口包括 49999。

因此不能直接复用当前以 `USER agent`、`WORKDIR /home/agent` 和自有 tini entrypoint 为核心的镜像。推荐做法是在镜像层面保持 root/S6 要求，但由 S6 service 以非 root `agent` 用户启动 BotCord daemon，避免扩大 daemon 运行权限。

### 7.3 生命周期实现

- 命令、文件、create/connect/kill 优先使用 E2B-compatible SDK。
- pause/resume/status 首先验证 E2B SDK 是否兼容；未明确或不稳定时使用腾讯 Cloud API。
- 对 `PAUSING -> PAUSED`、`RESUMING -> RUNNING` 进行有界轮询、超时和指标记录。
- 若开启平台自动暂停/自动恢复，必须关闭或协调 Hub idle sweep，防止两个控制器竞争。
- 如果使用 CFS，为每个 `CloudDaemonInstance` 分配隔离子目录，并验证销毁实例不会误删持久目录。

## 8. 成本比较

以下只比较公开列表价中的 2 vCPU / 1 GiB 运行计算成本，不含网络、存储超额、请求、订阅、折扣、税费和性能差异；美元按 ¥7.2 / USD 仅作内部估算。

| Provider | 计算公式 | 约每运行小时 | 相对 veFaaS |
| --- | --- | ---: | ---: |
| E2B | 2 × $0.000014/s + 1 × $0.0000045/s | $0.1170，约 ¥0.8424 | 2.57× |
| veFaaS | 2 × ¥0.0000405/s + 1 × ¥0.0000102/s | ¥0.32832 | 1.00× |
| 腾讯 AGSX | 2 × ¥0.000081/s + 1 × ¥0.000025/s | ¥0.67320 | 2.05× |

结论：

- veFaaS 列表计算价约比 E2B 低 61%。
- AGSX 列表计算价约比 E2B 低 20%，但约为 veFaaS 的 2.05 倍。
- veFaaS 暂停时停止 CPU/内存计费；AGSX 暂停时停止 CPU/内存计费，系统盘仍可能计费，当前公测优惠需要以账号账单为准。
- 真实决策必须用 POC 测得的启动时延、恢复时延、任务完成耗时和出网量换算为“每个活跃用户月成本”，不能只比较 vCPU 单价。

## 9. 实施阶段与 Gate

### Phase 0：商务准入与技术 POC

在改生产路径前，分别确认：

- veFaaS 北京地域 E2B 兼容、pause/resume、配额和镜像仓库权限已开通。
- 目标账号的 SLA、实例上限、快照上限、最大运行时间和实际计费状态。
- Hub、npm registry、模型 API 和必要第三方服务的公网/VPC 出口可达。

使用与生产一致的 BotCord 镜像做至少 20 轮 create → ready → pause → resume → ready → delete 循环，并覆盖：

- create 的 template、env、timeout、lifecycle 行为。
- connect timeout 和不存在实例的错误语义。
- `commands.run(background=True, envs=..., timeout=0)`。
- 暂停期间文件 sentinel 保留，veFaaS 进程和连接按预期丢失。
- 恢复后新 JWT 生效，旧 JWT/旧连接不再被使用。
- daemon hello、两个以上 agent 恢复、session/snapshot 可读取。
- 并发 pause/resume、重复请求、超时重试和 delete 幂等性。
- 账单中暂停窗口确实停止计算资源计费。

**Gate 0 通过条件：**上述核心调用面全部通过；没有文件丢失、重复 daemon 或无法清理实例；失败场景可被稳定分类；账号与配额满足灰度规模。

### Phase 1：Provider 路由改造

- 新增按 `CloudDaemonInstance.provider` 路由。
- 明确 provider 粘性：已有 active daemon 沿用记录中的 provider，仅为无 active daemon 的用户选择默认 provider。
- 为 unknown provider、provider/sandbox ID 不匹配增加错误码和告警。
- 覆盖 E2B 存量实例在默认 provider 切换后的 pause/resume/cleanup 测试。

**Gate 1：**默认 provider 任意切换时，存量 E2B 实例仍只由 E2B provider 操作。

### Phase 2：veFaaS Provider

- 将 E2B SDK 共用部分抽为可配置 transport。
- 增加 `vefaas` provider、独立配置和注册表项。
- 实现异步 pause/resume 状态轮询、超时、幂等和错误映射。
- 增加 mock 单元测试和受凭据保护的集成 smoke test。
- 为 provider API 延迟、状态转换、启动成功率、孤儿实例和成本增加指标。

**Gate 2：**测试环境全量通过，连续 7 天无无法回收实例，暂停/恢复成功率和恢复时延达到现有 E2B 基线或已获产品接受。

### Phase 3：小流量灰度

- 默认仍为 `e2b`，通过内部用户/allowlist 选择 `vefaas`。
- 新建用户先灰度 5%，再按 25% → 50% → 100% 提升。
- 迁移期间不原地修改已有实例的 provider。
- 对仍在 E2B 的用户采用自然淘汰；确需迁移时，导出必要文件后创建新的 veFaaS 实例，并保留可回退窗口。

**Gate 3：**至少一个完整账单周期或约定观察期内，成功率、P95 create/resume、孤儿率、用户任务成功率和单活跃用户成本满足目标。

### Phase 4：默认切换与 E2B 退场

- 将 `CLOUD_AGENT_DEFAULT_PROVIDER` 切为 `vefaas`。
- 继续保留 E2B provider、凭据和清理任务，直到最后一个 E2B 实例销毁。
- E2B 记录归零并核对云侧无残留实例后，才能移除 E2B 订阅或密钥。
- 若需要第二云，再按相同 contract 接入 `tencent_ags`，不改 Cloud Agent 业务层语义。

## 10. 测试矩阵

| 场景 | 单元测试 | veFaaS 集成 | AGSX 集成 |
| --- | :---: | :---: | :---: |
| provider-per-row 路由 | 必须 | 必须 | 必须 |
| create + 后台 daemon | mock | 必须 | 必须 |
| env/JWT 注入与日志脱敏 | 必须 | 必须 | 必须 |
| pause/resume 状态轮询 | 必须 | 必须 | 必须 |
| 暂停后文件保留 | - | 必须 | 必须 |
| 暂停后进程语义 | - | 验证丢失 | 验证保留但不依赖 |
| 重复 pause/resume/delete | 必须 | 必须 | 必须 |
| provider 超时与限流 | 必须 | 必须 | 必须 |
| Hub 重启后恢复实例 | 必须 | 必须 | 必须 |
| 两个 agent 共用 daemon | 必须 | 必须 | 必须 |
| 出网策略与 WebSocket 长连 | - | 必须 | 必须 |
| provider 切换后操作存量 E2B | 必须 | 必须 | 必须 |

## 11. 可观测性与告警

所有指标至少带 `provider`、`region`、`operation`、`result`，但不带用户凭据或完整 sandbox ID：

- create/connect/pause/resume/delete 次数、成功率和延迟。
- provider 原始状态到 BotCord 状态的转换耗时。
- daemon launch 到 WebSocket hello、agent ready 的耗时。
- 同一实例重复 daemon、resume storm 和 provisioning retry 次数。
- 数据库有记录但云侧 missing，以及云侧存在但数据库无 owner 的孤儿实例数。
- running/paused 实例数、vCPU·hour、GiB·hour、出网量和估算成本。

建议告警：

- 5 分钟窗口 resume 或 create 失败率超过基线阈值。
- 实例停留 `pausing` / `resuming` 超过 provider timeout。
- 孤儿实例非零并持续两个 sweep 周期。
- 默认 provider 凭据、配额或白名单不可用。
- 暂停后仍持续产生显著计算费用。

## 12. 安全要求

- daemon 仍以非 root 用户运行；AGSX 即使镜像要求 `USER root`，也通过 S6 降权启动业务进程。
- 每次 resume 重新签发短期 daemon JWT，不在快照中保存长期 Hub 凭据。
- 用户模型 API key 只在启动时注入，并确保 command/env 错误不会打印其值。
- 对 sandbox 出网实行最小范围策略；至少区分 Hub、模型 API、npm/包仓库和用户任务所需目标。
- Cloud API 凭据只授予 sandbox 生命周期所需最小权限，veFaaS 与 AGSX 使用独立账号/角色。
- 删除流程同时覆盖实例、快照、持久盘/CFS 路径和临时 provisioning 数据。

## 13. 回滚方案

灰度期间出现严重失败时：

1. 停止向 `vefaas` 分配新实例，将新实例默认 provider 切回 `e2b`。
2. 已存在 veFaaS 实例仍由 `vefaas` provider 管理，不能用 E2B provider 直接操作。
3. 对可恢复实例继续服务；对不可恢复实例导出文件或按既有灾难恢复策略重建 E2B sandbox。
4. 停止流量后执行 veFaaS 云侧与数据库双向对账，回收孤儿资源。
5. 保留失败样本的 provider state、request ID 和脱敏日志，修复后从内部 cohort 重新开始。

多 Provider 路由是回滚成立的前提。如果路由改造未完成，不允许切换生产默认 provider。

## 14. 建议 PR 顺序

1. `refactor: route cloud daemon lifecycle by stored provider`
2. `refactor: extract configurable e2b-compatible sandbox client`
3. `feat: add vefaas cloud daemon provider`
4. `build: publish botcord sandbox image for vefaas`
5. `test: add vefaas lifecycle smoke coverage`
6. `ops: add provider rollout metrics and reconciliation`
7. 可选：`feat: add tencent ags cloud daemon provider`

每个 PR 都应保持 E2B 现有测试通过；Provider 路由 PR 与 veFaaS 接入 PR 不合并，便于独立回滚和审查。

## 15. 上线前待确认项

- veFaaS 邀测资格、生产 SLA、配额、快照限制和北京地域容量。
- E2B-compatible create 对 `lifecycle.on_timeout=pause` 的准确映射。
- `connect(timeout=0)` 和 `commands.run(timeout=0)` 在 veFaaS 上的真实含义。
- pause 返回时快照是否已经可安全 resume，以及推荐轮询状态。
- veFaaS 公网出口 IP、VPC/NAT 方案和 WebSocket 长连接限制。
- AGSX 的 E2B SDK 是否原生兼容 pause/resume，及其 sandbox ID 与 Cloud API instance ID 的映射。
- 两家平台的正式计费、折扣、系统盘/快照和出网费用。
- 是否接受单地域主路径，或需要在首期同时建设 AGSX 第二云。

## 16. 官方资料

### 火山引擎

- [使用 E2B SDK 管理 veFaaS 云沙箱实例](https://www.volcengine.com/docs/6662/2548872?lang=zh)
- [暂停与恢复沙箱实例](https://www.volcengine.com/docs/6662/2548833?lang=zh)
- [创建沙箱实例 API](https://api.volcengine.com/api-docs/view?action=CreateSandbox&serviceCode=vefaas&version=2024-06-06)
- [自定义镜像与镜像预热](https://www.volcengine.com/docs/6662/1802883?lang=zh)
- [沙箱实例](https://www.volcengine.com/docs/6662/1802882?lang=zh)
- [公网访问与 NAT](https://www.volcengine.com/docs/6662/2272924?lang=zh)
- [AIO Sandbox](https://www.volcengine.com/docs/6662/1851199)
- [veFaaS 计费说明](https://www.volcengine.com/docs/6662/1269135?lang=zh)

### 腾讯云

- [Agent 沙箱服务 AGSX 产品页](https://cloud.tencent.com/product/agsx)
- [通过 E2B SDK 使用 Agent Runtime](https://cloud.tencent.com/document/product/1814/132253)
- [快速迁移 E2B 应用](https://cloud.tencent.com/document/product/1814/123816)
- [执行后台命令](https://cloud.tencent.com/document/product/1814/123850)
- [暂停与恢复实例](https://cloud.tencent.com/document/product/1814/132323)
- [暂停实例 API](https://cloud.tencent.com/document/product/1814/127876)
- [恢复实例 API](https://cloud.tencent.com/document/product/1814/127875)
- [产品优势与进程级快照](https://cloud.tencent.com/document/product/1814/123813)
- [自定义镜像与快照启动约束](https://cloud.tencent.com/document/product/1814/129691)
- [网络模式与 NetworkPolicy](https://cloud.tencent.com/document/product/1814/132216)
- [挂载 CFS](https://cloud.tencent.com/document/product/1814/129845)
- [计费概述](https://cloud.tencent.com/document/product/1814/133249)
- [地域公共参数](https://cloud.tencent.com/document/product/1814/124827)

### E2B

- [E2B Pricing](https://e2b.dev/pricing)

[PROTOCOL]: provider 接口、云厂商兼容能力、镜像约束或迁移结论变化时更新本文，并同步检查 cloud-agent-technical-design.md、cloud-agent-subscription-implementation-plan.md 与 docs/README.md。
