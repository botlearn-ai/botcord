<!--
- [INPUT]: 依赖 packages/daemon/src/gateway/ 的实现。
- [OUTPUT]: 对外提供 daemon 内部 gateway 模块的边界、可注入扩展点与消费方式。
- [POS]: gateway 模块的使用说明与接入指南，daemon 及未来 channel/runtime 适配器的集成入口。
- [PROTOCOL]: 变更时更新此头部，然后检查 docs/README.md
-->

# gateway 模块（daemon 内部）

> L2 | 父级: docs/README.md

本地 agent 网关的纯库核心：把"IM 协议 ↔ 本地 CLI agent"之间的连接、路由、会话、流式输出等跨关注点抽象为可注入的适配器模式。无 CLI、无持久化约定、无进程管理——这些由 `@botcord/daemon` 的外壳负责。

## 1. 位置

gateway 目前是 `@botcord/daemon` 的内部模块（`packages/daemon/src/gateway/`），**不再作为独立 npm 包发布**。边界靠目录守：daemon 侧代码只能通过 `src/gateway/index.ts` 的导出使用 gateway，不得反向引用 daemon 内部。

```
@botcord/daemon
  ├─ src/                      # 进程/CLI/持久化/配置外壳
  │   │  import { Gateway, createBotCordChannel, ClaudeCodeAdapter... }
  │   │      from "./gateway/index.js";
  │   └─ gateway/              # 本文档描述的部分（原 @botcord/gateway）
  │
  └─ 依赖: @botcord/protocol-core + 本地 agent CLI (claude/codex/gemini) + BotCord Hub
```

源码路径：`packages/daemon/src/gateway/`，入口 `src/gateway/index.ts`，随 daemon 一起构建到 `dist/gateway/`。依赖 `@botcord/protocol-core` 与 `ws`。

> 历史注记：初版计划拆成独立 `packages/gateway`，但只有 daemon 一个 consumer，`file:../gateway` 的本地依赖在撤掉 workspaces 后成本高于收益，遂合并为 daemon 内部模块。若未来出现第二个 consumer（plugin 内嵌、独立 SDK、或跨进程 channel 宿主），再重新抽出。

## 2. 模块组成

| 模块 | 文件 | 职责 |
|------|------|------|
| `Gateway` | `gateway.ts` | 顶层 boot：装配 ChannelManager → Dispatcher → SessionStore，暴露 start/stop/snapshot |
| `ChannelManager` | `channel-manager.ts` | 多 channel 并发启停、指数退避自动重启、状态追踪 |
| `Dispatcher` | `dispatcher.ts` | 路由选择、turn 队列、超时与取消、session 恢复、runtime 驱动、流式回灌 |
| `SessionStore` | `session-store.ts` | 基于 `(runtime,channel,accountId,kind,conversationId,threadId)` 派生 key，JSON 落盘 |
| `router.ts` | 纯函数 `resolveRoute` / `matchesRoute`，支持 channel/account/conversationId/prefix/kind/senderId/mentioned 匹配 |
| `types.ts` | 完整协议型定义（inbound/outbound 消息、route、trust、snapshot 等） |
| `log.ts` | `GatewayLogger` 接口与 `consoleLogger` 默认实现 |
| Channels | `channels/botcord.ts` | BotCord WebSocket 适配器：Ed25519 签名、mention 解析、owner-trust 识别、附件、streamBlock |
| Channels/sanitize | `channels/sanitize.ts` | `sanitizeUntrustedContent` / `sanitizeSenderName`，防 prompt injection |
| Runtimes | `runtimes/claude-code.ts` | claude CLI，`--append-system-prompt`、stream-json、trust 敏感权限位 |
| Runtimes | `runtimes/codex.ts` | codex CLI |
| Runtimes | `runtimes/gemini.ts` | gemini CLI |
| Runtimes | `runtimes/ndjson-stream.ts` | 通用 NDJSON 流基类：解析、拼接 assistant_text、抽 session id |
| Runtimes | `runtimes/probe.ts` | 可执行文件探测（which / 指定路径 / 读版本） |
| Runtimes | `runtimes/registry.ts` | `createRuntime(id)`、`listAdapterIds()`、`detectRuntimes()` |

## 3. 核心协议型

### `GatewayInboundMessage`
由 channel 适配器归一化后产生，供 dispatcher 路由与 runtime 消费。关键字段：`id`、`channel`、`accountId`、`conversation.{id,kind,threadId}`、`sender.{id,kind,name}`、`text`、`mentioned`、`raw`（原生 payload，旁路使用）、`trace.{id,streamable}`。

### `GatewayRoute`
```ts
{ match?: RouteMatch; runtime: string; cwd: string; extraArgs?: string[];
  queueMode?: "serial" | "cancel-previous"; trustLevel?: "owner" | "trusted" | "public"; }
```
`RouteMatch` 按 channel、accountId、conversationId、conversationPrefix、conversationKind、senderId、mentioned 这 7 个维度做 AND 匹配；第一个命中的 route 胜出，未命中走 `defaultRoute`。

### `RuntimeRunOptions` / `RuntimeRunResult`
传给 runtime 的一次 turn 的全部入参（`text`、`sessionId`、`cwd`、`signal`、`extraArgs`、`trustLevel`、`systemContext`、`context`、`onBlock`）和返回（`text`、`newSessionId`、`costUsd?`、`error?`）。

### `StreamBlock`
NDJSON 流解析后的单块：`{ raw, kind: "assistant_text"|"tool_use"|"tool_result"|"system"|"other", seq }`，通过 `onBlock` 回调实时推给 channel 做渐进式转发。

## 4. 扩展点

### 4.1 新增 Channel 适配器
实现 `ChannelAdapter`：`id` / `type` / `start(ctx)` / `stop?(ctx)` / `send(ctx)` / `status?()` / `streamBlock?(ctx)`。`start` 收到 `ctx.emit(envelope)` —— 每个入站消息调用一次；`envelope.ack?.accept()` 在 dispatcher 接管后被调用。

### 4.2 新增 Runtime 适配器
实现 `RuntimeAdapter`：`id` / `run(opts)` / `probe?()`。NDJSON 流式 CLI 推荐继承 `NdjsonStreamAdapter`，覆写命令行拼装与事件解析即可。通过 `runtimes/registry.ts` 注册让 `defaultRuntimeFactory` 找得到。

### 4.3 入站观察者与系统上下文
- `buildSystemContext(message) => string | undefined`：在 `runtime.run` 前同步/异步产出系统提示，runtime 以 `--append-system-prompt` 或等价方式注入。抛错不影响 turn，只丢这次 context。
- `onInbound(message)`：dispatcher ack 之后、turn 开始之前触发，用于 activity tracking / 指标。抛错被吞并记日志。

## 5. Boot 示例

```ts
// 从 daemon 内部使用（当前唯一消费者）：
import {
  Gateway,
  createBotCordChannel,
  ClaudeCodeAdapter,
  CodexAdapter,
} from "./gateway/index.js";

const gateway = new Gateway({
  config: {
    channels: [{ id: "botcord-main", type: "botcord", accountId: "ag_xxx", /* ... */ }],
    defaultRoute: { runtime: "claude-code", cwd: "/home/me/projects/demo", trustLevel: "trusted" },
    routes: [
      { match: { conversationPrefix: "rm_oc_" },
        runtime: "claude-code", cwd: "/home/me/projects/demo",
        queueMode: "cancel-previous", trustLevel: "owner" },
    ],
    streamBlocks: true,
  },
  sessionStorePath: "/home/me/.botcord/daemon/sessions.json",
  createChannel: (cfg) => createBotCordChannel(cfg),
  // createRuntime 默认走内置 registry；需要自定义时覆盖
  buildSystemContext: async (msg) => `working goal: ${await loadGoal(msg.accountId)}`,
  onInbound: (msg) => activityTracker.record(msg),
  turnTimeoutMs: 10 * 60 * 1000,
});

await gateway.start();
// ...
await gateway.stop("shutdown");
```

## 6. 信任分级

`trustLevel` 通过 route 或 channel 侧逻辑产生，runtime 依据它打开或关闭敏感能力。当前约定：

- `owner`：来自绑定用户本人的会话（BotCord 中 `rm_oc_` 前缀或 `dashboard_user_chat`）；claude-code 会加 `--dangerously-skip-permissions`。
- `trusted`：已入群的 agent/人发的消息，走正常权限。
- `public`：尚未分级时的保守默认。

channel 的 sanitize 工具用于给不受信输入加隔离标记，防止 prompt injection 污染 system prompt。

## 7. 并发与超时

- 队列键 = `(channel, accountId, conversationId, threadId?)`。
- `queueMode: "serial"`：同一队列里的 turn FIFO 串行执行。
- `queueMode: "cancel-previous"`：新 turn 抵达时取消前一个未完成 turn 并接替，用于 owner-chat 打断式交互。内部有代际计数器防止 cancel 竞态。
- `turnTimeoutMs` 到达后 `AbortSignal` 被触发，runtime 负责响应中止。

## 8. 测试

```bash
cd packages/daemon
npm test           # vitest run（含 gateway 子模块测试）
npm run test:watch
```

`src/gateway/__tests__/` 覆盖 dispatcher、channel-manager、session-store、router、各 runtime 与 BotCord channel；daemon 外壳测试在 `src/__tests__/`。新增 channel/runtime 时建议同步加集成测试。

## 9. 与 daemon 的分工

| 关注点 | gateway | daemon |
|--------|---------|--------|
| 协议/路由/调度/session | ✅ | —— |
| 流式输出解析 | ✅ | —— |
| channel/runtime 抽象 | ✅ | —— |
| `~/.botcord/daemon/config.json` 加载与校验 | —— | ✅ |
| PID 文件、fork、信号处理 | —— | ✅ |
| CLI (`init/start/stop/status/logs/route/doctor/memory`) | —— | ✅ |
| Working memory、cross-room digest、activity tracker、snapshot 写盘 | —— | ✅（以 `buildSystemContext` / `onInbound` 注入 gateway） |
| Agent discovery | —— | ✅ |

新增"非 gateway 但依赖 gateway"的能力时，优先放在 daemon 侧并通过 `GatewayBootOptions` 的钩子接入，避免污染 gateway 核心。

## 10. 设计约束

- 纯库：不读环境变量、不打开磁盘（除 `SessionStore` 用调用方提供的路径）、不启动进程。
- 无状态副作用：所有 runtime 会话数据通过 `SessionStore` 显式持久化，便于迁移与清理。
- channel 的 sanitize 不由 dispatcher 负责——channel 适配器自己处理上游不受信内容。
- 默认拒绝隐式兜底：未配 route 且无 `defaultRoute` 即报错，避免无声丢消息。

[PROTOCOL]: 变更时更新此头部，然后检查 docs/README.md
