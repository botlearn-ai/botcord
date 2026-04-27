# Hermes Agent Runtime 接入设计

## 背景

`@botcord/daemon` 已支持 Claude Code、Codex 两个本地 CLI 运行时（Gemini 仅探测），通过 `packages/daemon/src/gateway/runtimes/` 下的插件式适配器把 Hub 的 inbox 事件桥接到本地 agent。本文档定义如何把 [hermes-agent](https://github.com/NousResearch/hermes-agent)（路径 `~/claws/hermes-agent`）作为新 runtime 接入。

## hermes-agent 现状（已确认）

- Python 3.11+，pyproject `name = "hermes-agent"`，version `0.11.0`
- 三个入口（`pyproject.toml:128-131`）：
  - `hermes` → `hermes_cli.main:main`（交互式 TUI）
  - `hermes-agent` → `run_agent:main`（核心 Agent runner）
  - **`hermes-acp` → `acp_adapter.entry:main`** ← 我们要用的
- 配置目录由 `hermes_constants.get_hermes_home()` 决定，默认 `~/.hermes`，可被 `HERMES_HOME` 环境变量覆盖
- `.env` 从 `$HERMES_HOME/.env` 加载（`acp_adapter/entry.py:_load_env`）

### ACP（Agent Client Protocol）适配器

- 协议：JSON-RPC over stdio，由 `agent-client-protocol>=0.9.0,<1.0` 实现（`pyproject.toml` `[acp]` extra）
- 入口：`acp_adapter/entry.py`
  - stdout 留给 JSON-RPC，stderr 走日志（`_setup_logging` 在 `entry.py:65-83`）
  - 启动时清理 root logger handlers，避免污染 stdout
- server：`acp_adapter/server.py` 已实现完整 ACP 能力：
  - `InitializeResponse / NewSessionResponse / LoadSessionResponse / ResumeSessionResponse / ForkSessionResponse / ListSessionsResponse`
  - `PromptResponse` 流式回包：`TextContentBlock / ImageContentBlock / AudioContentBlock / EmbeddedResourceContentBlock`
  - 工具事件：`make_tool_progress_cb / make_step_cb / make_thinking_cb / make_message_cb`（`acp_adapter/events.py`）
  - 鉴权探测：`acp_adapter/auth.py:detect_provider`
  - 权限策略：`acp_adapter/permissions.py`

**结论**：会话生命周期、resume、流式 prompt、工具事件、思考块在 ACP 协议层全部内置，不需要 daemon 自己拼装 NDJSON。

### Oneshot 备选

`hermes_cli/oneshot.py` 实现了 `hermes -z "<prompt>"`：
- 设 `HERMES_YOLO_MODE=1 / HERMES_ACCEPT_HOOKS=1` 跳过审批
- 把 stderr+stdout 都重定向到 devnull，最后只把最终文本写到 real stdout
- 无 session、无流式、无工具事件 — 仅作为 ACP 不可用时的降级方案

## Daemon 现有 runtime 抽象

| 文件 | 作用 |
|---|---|
| `runtimes/registry.ts` | `RuntimeModule` 接口 + 工厂注册表 |
| `runtimes/ndjson-stream.ts` | 通用基类：spawn 子进程，按行解析 NDJSON，管理生命周期 |
| `runtimes/claude-code.ts` | Claude Code 适配器（`claude -p ... --output-format stream-json`） |
| `runtimes/codex.ts` | Codex 适配器（`codex exec`，systemContext 通过原子写 `$CODEX_HOME/AGENTS.md`） |
| `agent-workspace.ts:39-60` | per-agent 工作区 `~/.botcord/agents/{accountId}/{workspace,state,<runtime>-home}/` |
| `session-store.ts` | 持久化 `runtimeSessionId`，按 `{runtime, channel, accountId, conversationId, threadId}` 索引 |

`RuntimeRunOptions`：`{ text, sessionId?, cwd, accountId, signal, trustLevel, systemContext?, onBlock }`
`RuntimeRunResult`：`{ text, newSessionId, costUsd?, error? }`

## 设计

### 总体方案

不复用 `NdjsonStreamAdapter`（它面向自定义 NDJSON 流）。新建独立的 `AcpRuntimeAdapter` 基类，使用 ACP TS 客户端 SDK 直接消费 ACP 协议，hermes-agent 是它的第一个实例。

### 文件改动清单

| # | 文件 | 操作 | 说明 |
|---|---|---|---|
| 1 | `packages/daemon/src/gateway/runtimes/acp-stream.ts` | 新增 | ACP 适配器基类：spawn ACP server、握手、session 管理、prompt 流式分发 |
| 2 | `packages/daemon/src/gateway/runtimes/hermes-agent.ts` | 新增 | hermes-acp 适配器：解析 binary、准备 `HERMES_HOME`、决定 cwd、按 trustLevel 配置 `request_permission` 应答策略；systemContext 载体在「systemContext 注入」章节决定 |
| 3 | `packages/daemon/src/gateway/runtimes/registry.ts` | 修改 | 注册 `hermesAgentModule`（id=`"hermes-agent"`） |
| 4 | `packages/daemon/src/agent-workspace.ts` | 修改 | `ensureAgentWorkspace()` 增加 `hermes-home/`（HERMES_HOME 载体）+ `hermes-workspace/`（runtime cwd，与现有 `workspace/` 隔离）+ stub `.env` |
| 5 | `packages/daemon/package.json` | 修改 | 增加 `agent-client-protocol` TS 客户端依赖（如有 npm 包；否则自实现双向 ACP client：client→server request/response + server→client notification + server→client request，**不是 minimal JSON-RPC**） |
| 6 | `packages/daemon/src/gateway/__tests__/hermes-agent-adapter.test.ts` | 新增 | 用 mock ACP server 验证 prompt 流、session resume、`request_permission` 应答、错误传播（与现有 `claude-code-adapter.test.ts / codex-adapter.test.ts` 同目录） |

### Runtime 注册项

匹配 `registry.ts` 现有 `RuntimeModule` 形状（`binary` / `envVar?` / `probe(): RuntimeProbeResult` / `create(): RuntimeAdapter`，无 `binaryEnvVar / defaultBinary / deps` 这些参数）：

```ts
// registry.ts
export const hermesAgentModule: RuntimeModule = {
  id: "hermes-agent",
  displayName: "Hermes Agent",
  binary: "hermes-acp",
  envVar: "BOTCORD_HERMES_AGENT_BIN",
  probe: () => probeHermesAgent(),
  create: () => new HermesAgentAdapter(),
};
```

`probeHermesAgent()` 返回 `RuntimeProbeResult`（`{ available, path?, version? }`），版本信息通过 `hermes-acp --version` 解析；不可用时仅设 `available=false`，把"安装提示"文案放在 `doctor` 输出层而不是 probe 返回值。

### Spawn 参数

```
binary:  hermes-acp        (env override: BOTCORD_HERMES_AGENT_BIN)
args:    []                (ACP 是纯 stdio JSON-RPC，无命令行参数)
env:
  HERMES_HOME=~/.botcord/agents/{accountId}/hermes-home
  HERMES_INTERACTIVE=1     (启用 conn.request_permission 反向调用 — 由 daemon ACP client 应答)
  NO_COLOR=1
  PATH=继承
  # 注意：不再无条件设 HERMES_YOLO_MODE=1 / HERMES_ACCEPT_HOOKS=1，
  #       审批策略由 daemon 在 request_permission 回调里按 trustLevel 决策
cwd:     ~/.botcord/agents/{accountId}/hermes-workspace
         (新增的 runtime 私有目录，不复用现有 workspace/，避免覆盖用户/agent 编辑过的 AGENTS.md)
stdio:   ["pipe", "pipe", "pipe"]  // 双向 stdio 给 ACP，stderr 抓日志
```

### 会话映射

注意：本地 Hermes ACP server 的 `LoadSessionResponse / ResumeSessionResponse` **不携带 `session_id`** —— 服务端在 resume miss 时虽然会内部新建一个 session，但不会回传新的 id。如果 daemon 直接拿旧 id 继续 prompt 会被拒。因此：

| daemon 概念 | ACP 调用 | 说明 |
|---|---|---|
| 首次运行（无 sessionId） | `session/new` → 拿到 `session_id` | 写回 `RuntimeRunResult.newSessionId` |
| 续接（已有 sessionId） | 先 `session/load`：成功 → 直接 prompt，`newSessionId` 沿用旧 id；返回 null/错误 → fallback `session/new` 拿新 id | 不使用 `session/resume`（无 id 回传） |
| `RuntimeRunOptions.text` | `session/prompt` 的 `prompt` 字段（单 `TextContentBlock`） | |
| `onBlock(text)` 回调 | 来自服务端的 `session/update` 通知中的 `TextContentBlock` chunk | 工具事件 / 思考块按 daemon 现有约定折叠成文本 |
| 终止 | 收到 `PromptResponse` | 返回 `{text, newSessionId}` |

### systemContext 注入（未决，需选型）

两条独立约束：

- **存放路径约束**：hermes 的 `AGENTS.md` 是从**当前工作目录**逐级向上发现，`HERMES_HOME` 只承载 `.env / state.db / skills / SOUL.md`。写 `$HERMES_HOME/AGENTS.md` 会被忽略；写现有 `~/.botcord/agents/{accountId}/workspace/AGENTS.md` 会覆盖 `ensureAgentWorkspace()` 维护的、用户/agent 可编辑的工作区文件。
- **session 生命周期约束**：hermes 在 continuation session 里**复用 DB 中持久化的 system_prompt**，并不会每轮重新读 `AGENTS.md`。所以即便每轮覆写文件，**同一 hermes session 的后续轮次也拿不到更新后的 BotCord memory/digest**，文件方案天然只能首轮注入。

候选方案：

1. **首选 — 推 hermes-agent 暴露 ephemeral system prompt 通道（必须）**：在 ACP `session/prompt` 加 `system_context` 字段（或 server 接受 `HERMES_EPHEMERAL_PROMPT` 每轮注入而不落 DB）。这是真正能支持"每轮 systemContext 都更新"的唯一干净方案。**daemon 侧需要给 hermes-agent 提 PR**，否则下面两个方案都只能给"首轮注入"语义。
2. **次选（首版兜底）— 仅首轮注入到 runtime 私有 cwd 的 `AGENTS.md`**：cwd 用新增的 `~/.botcord/agents/{accountId}/hermes-workspace/`（**不是现有的 `workspace/`**），在该目录下写 `AGENTS.md`。文档里**显式标注**：systemContext 仅对 `session/new` 那轮生效，已有 sessionId 的续接轮次不会重读文件 → 后续轮次的 BotCord memory/digest 更新拿不到，需通过方案 1 解决，或退而求其次"达到一定阈值就强制开新 session"。
3. **末选 — prompt 拼接**：每轮把 systemContext 拼到 user prompt 前。能保证"每轮都有最新 context"，但全部进 transcript，token 浪费 + 影响 hermes 的多轮记忆质量。仅作为应急。

首版默认实施方案 2 + 同步给 hermes-agent 提方案 1 的 issue/PR；在方案 1 落地前，daemon 自检文档说明"systemContext 续接局限"。

### 进程生命周期

- ACP server 是长连接 stdio，理论上可以复用进程跨多轮 prompt，降低 Python 冷启动开销
- 首版**每轮 spawn-and-quit**（与 Claude Code / Codex 适配器对齐），简单可靠
- 后续优化：在 `AcpRuntimeAdapter` 里实现 per-`{accountId, sessionId}` 的进程池常驻

### 错误处理

| 场景 | 行为 |
|---|---|
| `hermes-acp` 不在 PATH | `probe()` 返回 `{ available: false }`；安装提示 `pip install "hermes-agent[acp]"` 由上层 `doctor` 渲染 |
| ACP `initialize` 协议不匹配 | 在 adapter 启动后立刻 fail，附带 stderr 末尾 |
| `session/load` 返回 null / 错误 | fallback `session/new`，记录 warn（不使用 `session/resume`） |
| Python 异常 | stderr 抓取 → `RuntimeRunResult.error.message` |
| `signal.aborted` | 关 stdin → SIGTERM 5s → SIGKILL（沿用 ndjson-stream.ts 的策略） |

### trustLevel 映射 与 审批通道（一期必做）

Hermes ACP server **不通过环境变量做静态 yolo**，审批是通过服务端反向调用客户端方法 `request_permission` 走的（启用条件 `HERMES_INTERACTIVE=1`）。这是 **server-initiated request**，daemon 的 ACP client 必须实现该方法，否则危险命令会超时或被默认拒绝、流式也会卡住。

因此 ACP client 一期必须支持：

1. **client → server**：`initialize / session/new / session/load / session/prompt`（标准 request/response）
2. **server → client notification**：`session/update`（流式块、工具进度、思考块）— 不应答，只 onBlock
3. **server → client request**：`request_permission`（Python SDK 抽象名；**wire 上 JSON-RPC `method` 是 `session/request_permission`**，daemon 自实现 ACP client 时按 wire 名注册路由）— 应答必须是真实 ACP schema 对象，**不是自定义字段**。当前 Hermes 用的 ACP schema 形如 `RequestPermissionResponse(outcome=...)`，wire 上 `option_id` 走 alias `optionId`：
   - 允许：`{ outcome: { outcome: "selected", optionId: "<服务端给的某个 PermissionOption.option_id>" } }`（即 `AllowedOutcome`）
   - 拒绝：`{ outcome: { outcome: "cancelled" } }`（即 `DeniedOutcome`，**没有 `optionId` / `reason` 字段**）

   ACP client 实现要点：解析请求里的 `PermissionOption[]`（每项有 `option_id / kind` 等元信息），daemon 决定"允许"时挑一个 option 的 `option_id` 用 `AllowedOutcome` 回传；决定"拒绝"时直接发 `cancelled`，不要塞自定义字段。`reason` 只能进 daemon 自己的审计日志，不发给服务端。

`request_permission` 的应答策略按 `RuntimeRunOptions.trustLevel` 决策：

| trustLevel | 决策 | ACP 应答 |
|---|---|---|
| `owner` | 全部自动通过 | `AllowedOutcome` + 选请求中 `kind=allow_*` 的首个 option 的 `option_id` |
| `trusted` | 读类 allow；写/执行类 allow + 写 daemon 审计日志 | 同上（理由仅落本地日志，不发服务端） |
| `public` | 读类 allow；写/执行类 deny | `DeniedOutcome`（`outcome: "cancelled"`），理由仅落本地日志 |

mock ACP server 在测试中要按真实 schema 返回 `PermissionOption[]`，daemon 端响应才与生产 hermes 一致。

未来扩展：把 `request_permission` 转发到 BotCord 的人工审批通道（room 通知 + 回执）。

## 安装假设

文档中明确写明前置条件：

```bash
# 用户机器上
pip install "hermes-agent[acp]"
# 或
uv tool install "hermes-agent[acp]"
# 验证
hermes-acp --version
```

未安装时，`probe()` 仅返回 `{ available: false }`；安装提示统一由 `doctor` 渲染层给出，不在 probe 返回值中携带 hint。

## 风险与未决项

1. **ACP TS 客户端**：需先确认 `agent-client-protocol` 是否发布了 TS/JS 包。如无，daemon 侧自实现的 ACP client **不是"minimal JSON-RPC"** —— 必须支持双向调用：
   - client→server request/response（initialize / session/* / prompt）
   - server→client notification（`session/update` 流式分发）
   - **server→client request**（`request_permission` 等审批回调，必须有应答路由）
   预估实现量比单向 RPC 翻倍（~300 行 + 测试）。
2. **图片 / 音频 ContentBlock 处理**：首版只接 `TextContentBlock`，其它类型 stringify 为占位符或丢弃。
3. **多模型路由**：daemon 当前没有把"用哪个模型"的偏好传给 runtime，hermes-agent 走自己的 config。后续可通过 `HERMES_INFERENCE_MODEL / HERMES_INFERENCE_PROVIDER` env 注入。
4. **Tool 审批 UI**：一期 daemon 在 `request_permission` 回调里按 trustLevel 自动挑选 ACP `PermissionOption.option_id` 应答（不再走 `HERMES_YOLO_MODE`）；未来扩展是把请求转发到 BotCord 的人工审批通道，等待 room 端回执后再选 option_id。

## 验收标准

1. 在用户机器上 `pip install hermes-agent[acp]` 后，dashboard 给一个 BotCord agent 的 runtime 选 "Hermes Agent"，发消息能拿到回复
2. 同一 conversation 多轮发送，session resume 工作（hermes 内部记忆得到延续）
3. 多个 BotCord agent 并发挂在 hermes runtime 上互不串扰（HERMES_HOME 隔离生效）
4. `npx botcord-daemon doctor` 能展示 hermes-acp 的探测结果与版本
5. `packages/daemon/src/gateway/__tests__/hermes-agent-adapter.test.ts` 全绿

## 实施顺序

1. 写 `acp-stream.ts` 基类 + 双向 ACP client（client→server request/response、server→client notification、server→client request `session/request_permission`；如无 npm 包则自实现） — 1d
2. 写 `hermes-agent.ts` 适配器 + workspace 改动 — 0.5d
3. 注册到 registry，跑通本地手测 — 0.5d
4. 单元测试 + mock ACP server — 1d
5. 文档：更新 `packages/daemon/docs/gateway.md` 和根 `CLAUDE.md` — 0.25d

合计 ~3.25 人天。
