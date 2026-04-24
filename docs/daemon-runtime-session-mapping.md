---
name: daemon-runtime-session-mapping
description: Daemon 侧 Hub 会话身份与 runtime (Claude Code / Codex / …) 原生 session id 的映射设计
type: design
---

# Daemon Runtime Session 映射设计

## 背景

Daemon 的 Gateway 会把 Hub 下发的消息转给不同 runtime（Claude Code、Codex、Gemini 等）执行。每个 runtime 自己有一套 session id 规则：

| Runtime | Session id 形态 | Resume 机制 |
|---------|-----------------|--------------|
| Claude Code | UUIDv4（或历史 session title） | `claude -p --resume <uuid>` |
| Codex | UUIDv7/v4 | `codex exec resume <uuid>`（当前禁用） |
| Gemini | (N/A) | 无内置 resume |
| OpenClaw | 自定义 | 通过其他通道 |

而 Hub 下发的消息只带 Hub 协议层的身份（`accountId` / `conversationId` / `threadId` 等），**格式不会和任何 runtime 的 session id 兼容**。

因此 daemon 必须自己维护一张映射表，解决两个问题：

1. 同一个 Hub 会话多轮之间，如何让 runtime 正确 resume。
2. runtime 换了、session 丢了、格式失效时，如何不崩也不污染其他会话。

## 设计原则

1. **Hub id 绝不进入 runtime argv**。Hub id 只用来算一个内部 key，不会作为 `--resume` 的参数。
2. **Runtime id 是 runtime 自己给、自己认的不透明值**。Daemon 不对它做格式假设，也不对它做校验（安全注入除外）。
3. **SessionStore 是映射的唯一真理来源**。磁盘 JSON 持久化，原子 rename 写入，重启后自动恢复。
4. **每个 runtime 独立映射**：runtime id 作为 key 的一部分，切 runtime 等于切 session，无冲突。
5. **Thread / Topic 天然隔离**：threadId 也是 key 的一部分，同一 room 里不同 topic 是完全独立的 session。

## Key 设计

由 `SessionKeyInput`（`packages/daemon/src/gateway/types.ts`）派生：

```
runtime : channel : accountId : conversationKind : conversationId [: threadId]
```

示例：

```
claude-code:botcord:ag_7f3a:direct:rm_dm_9c...
claude-code:botcord:ag_7f3a:group:rm_97623e:tp_a1b2
codex:botcord:ag_7f3a:group:rm_97623e
```

Key 里的所有字段都来自 Hub 协议层，稳定、可重算；daemon 重启只要 Hub 再发一条消息就能命中旧 entry。

## Value 设计

`GatewaySessionEntry`（`packages/daemon/src/gateway/types.ts`）：

```ts
{
  key: string;              // 上面算出来的 key
  runtime: string;          // "claude-code" | "codex" | ...
  runtimeSessionId: string; // runtime CLI 自己吐出来的原样字符串
  channel, accountId, conversationKind, conversationId, threadId;
  cwd: string;
  updatedAt: number;
}
```

关键字段是 `runtimeSessionId`：这是一个**不透明字符串**，daemon 只负责存进、取出、原样回传。

## 数据流（正常轮次）

```
Hub 消息
  │
  ▼
dispatcher.ts  sessionKey(...)  ← Hub 字段
  │
  ▼
sessionStore.get(key) → entry?.runtimeSessionId ?? null
  │
  ▼
adapter.run({ sessionId, cwd, systemContext, ... })
  │
  ▼
CLI spawn → stream-json 事件
  │   system.init { session_id: "..." }
  │   result     { session_id: "...", subtype: "success" }
  ▼
state.newSessionId  ← adapter 从事件里捞
  │
  ▼
dispatcher 上收 result → sessionStore.set({ key, runtimeSessionId: newSessionId, ... })
```

## 各 runtime 的策略

### Claude Code

- Adapter：`gateway/runtimes/claude-code.ts`
- 有 sessionId 时追加 `--resume <sid>`
- 从 `system.init.session_id` / `result.session_id` 写回 `newSessionId`
- 当 `result.subtype !== "success"` 时清空 `newSessionId`，由 dispatcher 删除旧 entry
- 连续性靠 `--append-system-prompt`（每轮注入，不进 transcript）

### Codex（特殊）

- Adapter：`gateway/runtimes/codex.ts`
- **主动禁用 resume**：`run()` 强制把 `sessionId` 置 null，`thread.started` 事件也不写 `newSessionId`
- 原因：Codex 没有 `--append-system-prompt`，systemContext 只能拼进 prompt 正文；一旦 resume，旧 systemContext 会在 transcript 里滚雪球
- 结果：codex 的 entry **永远不会被写入** SessionStore，每轮都是全新 session
- 连续性完全靠 systemContext（working memory + cross-room digest）

### 未来 runtime 接入清单

1. 继承 `NdjsonStreamAdapter`（或同等基类）。
2. 实现 `resolveBinary / buildArgs / handleEvent`。
3. 在 `handleEvent` 里把 runtime 给的 session id 写入 `ctx.state.newSessionId`。
4. 如果 runtime 不支持 resume 或有类似 Codex 的累积问题，在 `run()` 里把 sessionId 置 null、不写回 `newSessionId`。

## 安全性

- `spawn(binary, args, ...)` 用 argv 数组，不经 shell——sessionId 里的奇异字符不会触发注入。
- 已有加固：Codex 对 session id 做 UUID 校验；Claude Code 在 spawn 前要求 session id 不以 `-` 开头、且不含控制字符，避免被 CLI 误解析为 flag，同时保留历史 title 形态的兼容性。
- SessionStore 文件以 `mode: 0o600` 写入，磁盘层只允许 daemon 用户读。

## 失效与清理

Claude Code 在 resume 失败时也可能返回一个新的 `session_id`（那是个刚启起来就错掉的空会话）。当前实现已经避免把这个 id 落盘：

1. `packages/daemon/src/gateway/runtimes/claude-code.ts` 在 `result.subtype !== "success"` 时清空 `state.newSessionId`，并把 `result` 文本写入 `state.errorText`。
2. `packages/daemon/src/gateway/dispatcher.ts` 在 `result.newSessionId` 为空、当前 turn 原本带有旧 `sessionId`、且 `result.error` 存在时调用 `sessionStore.delete(key)`。

这形成了 adapter 与 dispatcher 的契约：

| Runtime result | Dispatcher 行为 |
|----------------|-----------------|
| `newSessionId` 非空 | upsert entry |
| `newSessionId` 为空 + 有旧 `sessionId` + `error` 非空 | 删除旧 entry |
| 其他情况 | 不写 SessionStore |

### 当前失效处理策略

| 场景 | 现状 | 建议 |
|------|------|------|
| Claude Code resume 目标 UUID 已不存在 | adapter 清空 `newSessionId`，dispatcher 删除旧 entry | 已实现；后续可把错误分类做得更精细 |
| Runtime 切换（route 的 runtime 变了） | key 包含 runtime，旧 entry 自然不会命中；Gateway 启动时按 TTL 清理长期未访问 entry | 已实现 30 天默认 TTL；可按部署需要暴露配置 |
| 二进制升级导致格式不兼容 | adapter 负责兼容；否则失败回落到第 1 条 | 同上 |
| Hub 侧 thread 关闭 / room 删除 | entry 不再被访问 | 依赖 SessionStore TTL 清理 |

### 仍可补强

1. 把 30 天 SessionStore TTL 暴露到 daemon 配置，而不是只在 GatewayBootOptions 里可调。
2. 可选增加"resume 失败计数"，连续 N 次失败后主动丢弃并重建。
3. 对错误做更细粒度分类，区分 resume stale、认证失败、CLI 崩溃等。

## 可观测性

- `SessionStore.all()` 返回全量 entry，可暴露到 daemon 的 status/debug 接口。
- dispatcher 日志包含 `sessionId` / `queueKey`，便于按 Hub 会话定位 runtime session。
- stale session 删除日志包含 `prevRuntimeSessionId`；upsert 日志包含 `prevRuntimeSessionId` / `nextRuntimeSessionId`，让 "何时换了 UUID" 一目了然。

## 总结

Daemon 通过 **"Hub 身份组合 → 稳定 key → 存 runtime 自己后来报的 id"** 这张单向、懒写入的映射表，把两侧身份空间彻底隔开：

- Hub 侧只管 `rm_xxx / tp_xxx / ag_xxx`
- Runtime 侧只管自己原生 UUID / title
- Daemon 不在两者之间做格式转换，只做"按 Hub 身份查/存 runtime 原样 id"的 KV

这套设计的代价是每个 runtime 的失效语义要各自处理。Claude Code 的 stale resume 已有删除保护，Claude/Codex 都有 session id argv 安全保护，SessionStore 也会清理长期未访问 entry；后续主要补强点是把 TTL 暴露到配置、增加 resume 失败计数，以及更细粒度的错误分类。
