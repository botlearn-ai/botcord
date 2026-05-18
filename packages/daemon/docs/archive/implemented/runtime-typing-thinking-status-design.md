# Runtime Typing / Thinking 状态设计

## 背景

`@botcord/daemon` 现在已经支持把 runtime 的流式输出通过 `onBlock -> channel.streamBlock -> /hub/stream-block -> owner-chat WS` 回灌到 Dashboard。这个链路能展示 assistant 文本、工具调用、工具结果等执行块，但还缺少两个用户感知很强的中间状态：

- `typing`：daemon 已接管用户消息，agent 正在处理，但 runtime 还没有产生任何可展示执行块。
- `thinking`：runtime 已进入推理、规划或工具执行阶段，但还没有产生最终 assistant prose。

这两个状态看起来相近，但协议语义不同。`typing` 是 ephemeral presence，表示“对方正在回应”；`thinking` 是 trace-bound execution state，表示“这一次 runtime turn 正在发生什么”。

## 现有链路

| 层 | 现状 |
|---|---|
| daemon dispatcher | `RuntimeRunOptions.onBlock` 接收 runtime 解析出的 `StreamBlock`，并在 owner-chat 可流式场景调用 `channel.streamBlock` |
| daemon BotCord channel | `streamBlock()` POST 到 Hub `/hub/stream-block` |
| Hub typing | 已有 `POST /hub/typing`，会广播 `typing` realtime / owner-chat WS 事件 |
| Hub stream block | `/hub/stream-block` 按 `trace_id` 找 owner-chat WS 订阅并推送 `stream_block` |
| frontend owner-chat | 收到 `typing` 设置 `agentTyping=true`；收到 `stream_block` 创建/更新 streaming placeholder；有 streaming message 时隐藏 typing dots |

结论：首版不需要引入新传输通道。`typing` 复用 `/hub/typing`，`thinking` 复用 `/hub/stream-block`。

## 设计原则

1. `typing` 不进入 transcript，不持久化，不绑定 trace，可丢弃。
2. `thinking` 绑定 `trace_id`，作为 stream block 进入当前 turn 的 streaming message。
3. runtime adapter 只表达自己看见的事件，dispatcher 负责 turn 生命周期上的兜底状态。
4. 所有 stopped/terminal 状态必须在 success、error、timeout、abort 路径上收束，避免 Dashboard 卡在“正在输入”。
5. 非 owner-chat 房间首版不展示 daemon runtime status。非 owner-chat 的普通文本输出仍由现有 reply gating 规则处理。

## 协议模型

### Runtime status event

在 daemon 内部增加一个轻量状态回调，用于 dispatcher 和 runtime adapter 之间表达生命周期状态：

```ts
export type RuntimeStatusEvent =
  | {
      kind: "typing";
      phase: "started" | "stopped";
    }
  | {
      kind: "thinking";
      phase: "started" | "updated" | "stopped";
      label?: string;
      raw?: unknown;
    };

export interface RuntimeRunOptions {
  // existing fields...
  onBlock?: (block: StreamBlock) => void;
  onStatus?: (event: RuntimeStatusEvent) => void;
}
```

`onStatus` 是 daemon 内部扩展点，不直接暴露给 Hub。dispatcher 根据 channel 能力决定如何转发。

### StreamBlock kind 扩展

`thinking` 应进入 stream block，因为它是当前 trace 的执行状态：

```ts
export interface StreamBlock {
  raw: unknown;
  kind:
    | "assistant_text"
    | "tool_use"
    | "tool_result"
    | "system"
    | "thinking"
    | "other";
  seq: number;
}
```

不建议加入 `typing` kind。`typing` 不是 runtime 输出，也不应该占用 trace block 序列。

### Hub stream-block payload

BotCord channel 的 `normalizeBlockForHub()` 增加 `thinking` 映射：

```json
{
  "kind": "thinking",
  "seq": 1,
  "payload": {
    "phase": "started",
    "label": "Thinking"
  }
}
```

如果 runtime 能提供更具体的信息，可以设置：

```json
{
  "kind": "thinking",
  "seq": 4,
  "payload": {
    "phase": "updated",
    "label": "Searching web"
  }
}
```

## 状态流转

### Owner-chat 普通 turn

```text
user message accepted
  -> dispatcher emits typing.started
  -> daemon calls /hub/typing
  -> runtime starts
  -> first runtime block arrives
     -> dispatcher emits typing.stopped
     -> if block is non-assistant execution state, send thinking stream block
  -> assistant_text arrives
     -> send assistant stream block
     -> thinking considered stopped
  -> final result sent as normal message
     -> frontend finalizeStream(trace_id)
```

### Timeout / error / abort

```text
turn terminal path
  -> typing.stopped
  -> thinking.stopped if previously started
  -> existing timeout/error reply behavior remains unchanged
```

`thinking.stopped` 不一定需要发给 frontend。前端可以通过 final message、error message、disconnect、或 `activeTraceId=null` 收束。但 daemon 内部仍应维护这个状态，方便日志和未来 telemetry。

## Dispatcher 责任

dispatcher 是最适合做状态收束的地方，因为它同时知道：

- turn 是否进入 runtime；
- 当前 channel 是否 streamable；
- trace id；
- timeout / cancel / runtime error；
- final reply 是否真的发送给 owner-chat。

建议新增局部状态：

```ts
let typingActive = false;
let thinkingActive = false;
let sawRuntimeBlock = false;
let sawAssistantText = false;
```

行为：

1. 在 `runtime.run()` 前，如果 `canStream`，发送 `typing.started`。
2. 第一个 `onBlock` 到达时，发送 `typing.stopped`。
3. 如果 block 是 `system` / `other` 且能识别为 turn started，或 runtime adapter 明确发 `thinking.started`，则发 thinking block。
4. `tool_use` 到达时，如果未进入 thinking，先发 `thinking.started`，再正常转发 tool block。
5. `assistant_text` 到达时，认为用户已经能看到正文，停止 thinking。
6. `finally` 里统一停止 typing/thinking。

注意：现有 `onBlock` 是同步回调，`channel.streamBlock()` 是 fire-and-forget。状态事件也应保持 fire-and-forget，失败只记 warn，不能影响 runtime turn。

## Runtime adapter 映射

### Codex

Codex JSONL 事件可保守映射：

| Codex event | daemon 状态 |
|---|---|
| `thread.started` | `thinking.started`，label=`Starting session` |
| `turn.started` | `thinking.started`，label=`Thinking` |
| `item.started` with `command_execution` / `web_search` / `mcp_tool_call` | `thinking.updated`，label=工具类型 |
| `item.completed` with `agent_message` | `assistant_text`，停止 thinking |
| `turn.completed` | terminal，停止 thinking |

### Claude Code

Claude stream-json 事件可保守映射：

| Claude event | daemon 状态 |
|---|---|
| `system` init | `thinking.started`，label=`Starting session` |
| `assistant` content contains only `tool_use` | `thinking.updated`，label=工具名 |
| `assistant` content contains `text` | `assistant_text`，停止 thinking |
| `result` | terminal，停止 thinking |

Claude 有时同一个 `assistant` block 同时包含 text 和 tool_use。此时仍按现有规则转发 tool block，同时 frontend 从 raw content 中抽取 text；状态上只要出现 text，就不再显示纯 thinking。

### ACP / Hermes Agent

ACP 更适合表达 thinking，因为协议里通常有 `session/update`，并可能带 step、message、thinking、tool progress 等结构：

| ACP update | daemon 状态 |
|---|---|
| thinking update | `thinking.updated` |
| step/tool progress | `thinking.updated` |
| text content block | `assistant_text` |
| prompt response done | terminal |

Hermes Agent 适配器优先保留原始 ACP update 到 `raw`，label 做 best-effort 提取。

## Hub 变更

首版 Hub 可以不改 database。

需要的变更：

1. `/hub/typing` 继续承担 typing started 通知。当前接口没有 stopped 语义，frontend 使用超时或收到 stream/message 后自动清除。
2. `/hub/stream-block` 接收 `kind="thinking"` 的 block，并原样推给 owner-chat WS。
3. 如需要更明确的结束语义，后续可扩展 stream block：`{ kind:"status", payload:{ name:"thinking", phase:"stopped" } }`，但首版不要求。

不建议把 thinking 塞进 `/hub/typing`。typing endpoint 面向房间 presence，已有 dedup/rate-limit 语义；thinking 是单次 trace 的执行状态。

## Frontend 变更

owner-chat store 当前收到任何 stream block 都会创建 streaming placeholder，并清掉 `agentTyping`。可以在此基础上做两点增强：

1. `extractAssistantText()` 忽略 `thinking` block。
2. `UserChatPane` / `StreamBlocksView` 对只有 thinking/tool、没有 assistant text 的 streaming message 展示 compact 状态，例如 `Thinking...` 或最近一个 thinking label。

展示规则：

| 状态 | UI |
|---|---|
| `agentTyping=true` 且无 streaming message | typing dots |
| streaming message 只有 thinking block | `Thinking...` |
| streaming message 有 tool block | 显示工具执行块 |
| streaming message 有 assistant text | 显示流式正文 |
| final message 到达 | `finalizeStream()`，保留非 assistant execution blocks |

## 安全与限流

- `typing` 继续使用 Hub 现有 dedup 和 rate limit。
- `thinking` 走 `/hub/stream-block`，沿用 per-trace block count cap。
- thinking label 必须当作不可信字符串渲染，不能作为 HTML 注入。
- raw runtime event 只进入 owner-chat stream，不进入普通房间消息。
- 非 owner-chat 不展示 runtime 内部状态，避免把本地执行细节广播给公共房间。

## 落地步骤

1. 类型扩展：在 `packages/daemon/src/gateway/types.ts` 增加 `RuntimeStatusEvent`、`RuntimeRunOptions.onStatus`、`StreamBlock.kind="thinking"`。
2. Dispatcher：在 owner-chat `canStream` 场景发送 typing started；首个 block 和 terminal path 清除 typing；把 runtime status 转为 stream block。
3. BotCord channel：增加 `thinking` normalize，payload 至少包含 `phase` / `label`。
4. Runtime adapters：Codex、Claude、ACP adapter 分别做 best-effort thinking 映射。
5. Frontend：让 streaming placeholder 在无 assistant text 时显示 thinking 状态。
6. 测试：覆盖 typing started、首 block 清 typing、thinking block normalize、timeout/error 收束、frontend thinking block 不生成正文。

## 测试建议

| 包 | 测试 |
|---|---|
| daemon | dispatcher owner-chat：runtime 开始后调用 typing；首个 block 后停止 typing；timeout/error 不残留状态 |
| daemon | botcord channel：`thinking` block normalize 成 `{ kind:"thinking", payload:{...} }` |
| daemon | codex/claude adapter：对应事件产生 thinking 或 assistant block |
| backend | `/hub/stream-block` 接收 `thinking` block 并通过 owner-chat WS 推送 |
| frontend | `useOwnerChatStore.appendStreamBlock()` 收到 thinking 后创建 streaming placeholder 但不追加正文 |

## 首版边界

- 不做可恢复的 thinking history；刷新页面后只看最终消息。
- 不为普通群聊展示 runtime status。
- 不强求所有 runtime 都有真实 reasoning token；可以用 turn/tool 生命周期做保守映射。
- 不把 `typing.stopped` 加到 Hub typing API；首版由 frontend 在 stream/message/timeout 后清理。
