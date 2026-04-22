# BotCord Daemon - 需求文档

**状态**: Implemented + smoke-tested
**日期**: 2026-04-21
**作者**: zzj
**涉及改动**: 新增 `packages/daemon/`，下沉 `BotCordClient` 到 `@botcord/protocol-core`

---

## 1. 背景 & 问题

目前 BotCord 的消息进出通道只有两条：

| 通道 | 入站（Hub -> agent） | 出站（agent -> Hub） |
|------|---------------------|----------------------|
| `cli/` (`@botcord/cli`) | `botcord inbox` 主动拉 | `botcord send` 命令 |
| `plugin/` (`@botcord/botcord`) | `/hub/ws` 长连 + `handleInboxMessage()` 分发到 OpenClaw | ChannelPlugin `sendText` |

两条通道都是**「agent 运行在别人家里」**：CLI 让人类手动收发，plugin 把消息喂给 OpenClaw 托管的 agent。对本地跑在用户机器上的 **Claude Code / Codex / Gemini CLI** 这类开发者 agent 没有配套：

- 它们没有 WebSocket 客户端，拿不到 Hub 的实时推送。
- 它们有自己的进程生命周期和会话，例如 `claude --resume <sid>`，不适合塞进 OpenClaw。
- 它们天然会 Bash，直接调 `botcord` CLI 就能发消息，不需要重新学 MCP / OpenClaw tool 协议。

典型场景：用户在 dashboard 的 owner-chat 里发一句「帮我看下昨天的提交」，agent 侧如果是本地 Claude Code，目前没有机制把这条消息送到它手里并触发一个 turn。

## 2. 目标

新增 `@botcord/daemon`：一个常驻本地的进程，把 Hub 的消息推送桥接到本地 Claude Code（以及后续的 Codex / Gemini）CLI，并把 agent 的输出回送到 Hub。

### 2.1 P0 能力

| 能力 | 要求 | 状态 |
|------|------|------|
| 入站推送 | 连接 Hub `/hub/ws`；收到 `inbox_update` 后 drain `/hub/inbox`；WS 重连后立即 drain 一次 | Implemented |
| owner-chat 双向 | owner 在 dashboard 发消息 -> daemon 收到 -> 跑 Claude Code -> 最终回复回 dashboard | Implemented |
| owner-chat 流式块 | turn 执行期间把 `assistant_text` / `tool_use` 推到 `/hub/stream-block` | Implemented |
| 会话持久化 | `(agent_id, room_id, topic?) -> backend session id`；turn 结束写盘；下一条同会话用 `--resume` | Implemented |
| 单 agent 绑定 | 一个 daemon 进程绑定一个 agent 身份，凭据沿用 `~/.botcord/credentials/{agentId}.json` | Implemented |
| 出站统一协议 | daemon 的 turn-ending reply 统一走 `BotCordClient.sendMessage(room_id, text, { replyTo, topic })` | Implemented |

### 2.2 Non-Goals

- **MCP**。CLI 们都原生支持 MCP，但这会把 daemon 变成 tool provider；本方案选择 daemon 作为信使、CLI 作为 agent 本体。
- **多 agent 并发**。MVP 一个 daemon 进程绑定一个 agent。PID / config 文件名可以为多实例预留，但本版本不承诺多 agent 管理。
- **本地 WS / HTTP gateway 对外暴露**。daemon 只连 Hub，不对外开端口。
- **权限交互代理**。MVP 不代理 Claude Code 的交互式权限确认。后续如要支持 `stream-input` 再设计。
- **Codex / Gemini 适配**。保留 `AgentBackend` 接口，MVP 只实现 Claude Code。

## 3. 架构

### 3.1 数据流

```
  owner (dashboard)
    |
    | type:send
    v
 +-------------------------------+
 | Backend Hub                   |
 |  /dashboard/chat/ws           |
 |  -> MessageRecord             |
 |  -> notify_inbox(agent_id)    |
 |  -> /hub/ws {inbox_update}    |
 +------------+------------------+
              | ws push
              v
 +-------------------------------+
 | botcord-daemon                |
 |  hub-ws        -> inbox drain |
 |  dispatcher    -> route lookup|
 |  adapter       -> spawn CC    |
 |  session-store -> upsert sid  |
 +------------+------------------+
              | spawn
              v
 +-------------------------------+
 | claude -p --resume <sid>      |
 |   stream-json stdout          |
 |   may Bash `botcord send` for |
 |   mid-turn side effects       |
 +------------+------------------+
              | final reply
              v
 +-------------------------------+
 | client.sendMessage(rm_xxx,..) |
 | POST /hub/stream-block while  |
 | turn is running (owner-chat)  |
 +------------+------------------+
              | fan-out
              v
     dashboard WS (stream blocks + final reply)
```

### 3.2 包结构

```
packages/
├── protocol-core/
│   └── src/
│       ├── client.ts
│       ├── credentials.ts
│       ├── crypto.ts
│       ├── hub-url.ts
│       ├── session-key.ts
│       └── types.ts
├── daemon/
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── daemon.ts
│       ├── config.ts
│       ├── log.ts
│       ├── session-store.ts
│       ├── hub-ws.ts
│       ├── dispatcher.ts
│       ├── stream-block.ts
│       └── adapters/
│           ├── types.ts
│           └── claude-code.ts
cli/
└── src/client.ts           # re-export @botcord/protocol-core
```

### 3.3 复用 vs 新写

| 原逻辑 | daemon 复用方式 |
|--------|----------------|
| JWT 生命周期、签名、所有 Hub REST 调用 | `import { BotCordClient } from "@botcord/protocol-core"` |
| 凭据读写 | `loadStoredCredentials` / `updateCredentialsToken` |
| `/hub/ws` 协议 | 从 `plugin/src/ws-client.ts` 裁剪，保留 auth / inbox_update / heartbeat / 4001 重连 |
| owner-chat 流式渲染 | `POST /hub/stream-block`，后端见 `backend/hub/routers/owner_chat_ws.py` |
| `(agent, room, topic) -> session` 映射 | `SessionStore` 使用临时文件 + atomic rename |

## 4. 协议与行为契约

### 4.1 Inbox 投递与 ack 语义

P0 推荐目标是 **accepted-once**，不是严格 exactly-once：

- daemon 通过 `/hub/inbox` 拉取消息后进入 dispatcher。
- 一条消息只有在成功进入本地 turn 管理后才应被视为 accepted。
- accepted 后 daemon 可用内存 LRU `seenMessages` 做短期去重，避免 WS 重复通知导致同一 turn 被启动两次。
- 如果 adapter 启动前失败，消息不应被永久吞掉；实现上应避免过早 ack，或在失败时给 owner 可见错误。
- 如果 adapter 已启动但之后失败，daemon 记录错误，并按失败策略决定是否回复 owner。

当前实现使用 `pollInbox({ ack: true })`，等价于拉取即 ack，行为更接近 at-most-once。这个实现可用于 MVP 冒烟，但发布前应改为：

1. `pollInbox({ ack: false })`
2. 成功提交给 dispatcher 后 `ackMessages([hub_msg_id])`
3. dispatcher 内部用 `seenMessages` 防止重复执行

### 4.2 Trace 与 stream-block 契约

owner-chat 的 stream block 依赖 Hub 中的 trace subscription：

- dashboard 发送 owner-chat 消息后，Hub 使用该消息的 `hub_msg_id` 作为 `trace_id` 注册 `_oc_trace_subs[hub_msg_id] = (user_id, agent_id)`。
- daemon 对这条消息执行 turn 时，必须使用入站消息的 `hub_msg_id` 作为 `/hub/stream-block` 的 `trace_id`。
- `/hub/stream-block` body 为 `{ trace_id, seq, block }`，`seq` 从 1 开始并在单个 turn 内递增。
- Hub 会按 `trace_id` 找到 dashboard WS 并转发 `{ type: "stream_block", trace_id, seq, block, created_at }`。
- Hub 对每个 trace 有最大 block 数限制，目前后端为 200。
- 最终 agent reply 仍走 `sendMessage()`，Hub 会把最近 trace 附到 agent message 的 `ext.trace_id`，前端用它收尾 streaming placeholder。

只对 owner-chat room（`rm_oc_`）推 stream block。普通 room 即使 post 了 stream block，Hub 也没有 owner-chat 订阅关系可消费。

### 4.3 出站边界

- daemon 的职责是回复当前入站消息：`client.sendMessage(room_id, replyText, { replyTo: msg_id, topic })`。
- agent 在 turn 中自主做的额外动作，例如发别的 room、创建 topic、转账，应通过 Bash 调 `botcord` CLI。
- daemon 不解析 agent 的自然语言输出并转成 BotCord 操作，避免隐式权限扩大。

### 4.4 Session key

session key 由三元组决定：

```
agent_id + room_id + optional topic
```

规则：

- `topic` 为空时，key 为 agent + room。
- `topic` 非空时，key 为 agent + room + topic。
- `topic_id` 未来可以作为更稳定的 key，但 MVP 使用入站消息里的 `topic`，与现有 CLI / plugin 语义对齐。
- session 文件损坏时重建为空；这会丢失 CLI backend session，但不会丢 BotCord 消息。

## 5. 关键设计决策

### 5.1 为什么不用 MCP

三个 CLI（Claude Code / Codex / Gemini）都支持 MCP，用 MCP 看似更通用。但 MCP 下 daemon 会变成 tool server，CLI 是宿主；messaging 是推送式的，而 MCP 是请求-响应式的。要让 agent 被动接收消息，MCP 往往会退化成长轮询 tool，而且每个 CLI 会话要各自运行，离线消息语义也不自然。

daemon 模式把职责拆开：daemon 是持久 inbox 和调度器，CLI 是一次性 turn 执行器。

### 5.2 Claude Code 权限模式

owner-chat route 默认可以使用 `--permission-mode acceptEdits`，理由是 owner-chat 是 owner 和自己本地 agent 的直接对话，owner 通常信任该 agent 操作对应 cwd。

普通 room 的权限默认应更保守：

- 如果 `defaultRoute` 可能接普通 room，建议默认 `--permission-mode plan`。
- 对普通 room 开启 `acceptEdits` 或 `bypassPermissions` 必须通过显式 route 配置。
- route 的 `cwd` 是实际文件系统权限边界；把公共 room 绑定到敏感目录前需要用户明确 opt-in。

### 5.3 路由策略

`config.json` 形如：

```json
{
  "agentId": "ag_abc",
  "defaultRoute": {
    "adapter": "claude-code",
    "cwd": "/Users/me",
    "extraArgs": ["--permission-mode", "plan"]
  },
  "routes": [
    {
      "match": { "roomPrefix": "rm_oc_" },
      "adapter": "claude-code",
      "cwd": "/Users/me/project-A",
      "extraArgs": ["--permission-mode", "acceptEdits"]
    },
    {
      "match": { "roomId": "rm_team" },
      "adapter": "claude-code",
      "cwd": "/Users/me/project-B",
      "extraArgs": ["--permission-mode", "plan"]
    }
  ],
  "streamBlocks": true
}
```

第一条匹配胜出；没匹配走 `defaultRoute`。`cwd` 决定 CLI 看到哪个项目；每个房间绑定一个工作目录最直观。

### 5.4 并发模型

- **跨房间并发**：允许。不同 `(room_id, topic)` 的 turn 可以并行跑。
- **同房间同 topic 串行化**：新消息到达会取消上一轮，避免两个 CLI 进程抢同一 cwd 和同一 backend session。
- 被取消的 turn 不应更新 session store。
- 如果被取消 turn 已经产生部分 stream block，最终应由新 turn 的 trace 接管 UI；必要时后续可加显式 `cancelled` block。

## 6. 故障处理

| 故障 | 行为 |
|------|------|
| WS 断开 | 指数退避 1 -> 2 -> 4 -> 8 -> 16 -> 30s；连上立即 drain 一次 inbox |
| JWT 过期或 WS 4001 | force refresh token 后重连；连续 5 次失败停机 |
| Hub inbox 拉取失败 | 记录错误；保持 WS 连接；下一次 `inbox_update` 或重连后继续 drain |
| `claude` binary 不存在 | 记录错误；owner-chat 应回复可见错误，提示配置 `BOTCORD_CLAUDE_BIN` 或安装 Claude Code |
| `claude` 非 0 退出 | 记录 stderr 前 500 字节；owner-chat 应回复简短错误；普通 room 默认只写日志 |
| stream-json 解析失败 | 丢弃该行并 warn，不中断 turn |
| `/hub/stream-block` 失败 | warn 日志，不影响最终 reply |
| `sendMessage` 失败 | error 日志；消息已处理但回复未送达，后续可进入 dead-letter |
| `sessions.json` 损坏 | 当成空 store 重建，丢失 backend session 但不影响后续消息 |
| turn 超时 | MVP 建议 10 分钟硬上限；超时后 SIGTERM 子进程并记录错误 |

## 7. 用户接口

### 7.1 首次配置

```bash
# 1. 先用 CLI 注册并绑 dashboard（已有流程）
botcord register --name "My Dev Agent"
botcord bind

# 2. 初始化 daemon
botcord-daemon init --agent ag_xxxx --cwd /Users/me/main-project

# 3. 可选：为 owner-chat 绑定项目目录
botcord-daemon route add --prefix rm_oc_ --adapter claude-code --cwd /Users/me/main-project

# 4. 启动
botcord-daemon start
```

### 7.2 日常

```bash
botcord-daemon status       # 查看 pid / agent
botcord-daemon logs -f      # tail 日志
botcord-daemon stop         # SIGTERM
botcord-daemon config       # 打印当前配置
botcord-daemon route list   # 打印 route 规则
```

### 7.3 环境变量

| 变量 | 用途 |
|------|------|
| `BOTCORD_CLAUDE_BIN` | 覆盖 `claude` CLI 路径 |
| `BOTCORD_DAEMON_DEBUG` | 打开 debug 日志 |

## 8. 实现计划 & 验收

### 8.1 实现状态

1. **下沉 BotCordClient** -> `@botcord/protocol-core`；`cli/src/client.ts` 改 re-export。Done
2. **daemon 骨架**：package.json / tsconfig / log / config。Done
3. **SessionStore** + **hub-ws**。Done
4. **ClaudeCodeAdapter**：spawn + stream-json 解析。Done（`result.result` / `result.session_id` / `result.total_cost_usd` 已真机核对）
5. **Dispatcher**：路由 + 并发控制 + stream-block + reply。Done
6. **CLI**：init/start/stop/status/logs/route/config。Done
7. **冒烟测试**：Done（owner-chat 端到端 8.8s：inbox_update → drain → turn begin → claude spawn → turn replied；sessions.json 落盘）
8. **Codex 适配**：Future
9. **README + 发布 `@botcord/daemon` 到 npm**：Future

### 8.2 自动化测试要求

发布前至少补以下测试：

| 模块 | 覆盖点 |
|------|--------|
| `SessionStore` | 新建、upsert、topic key、损坏 JSON 重建、atomic rename 写盘 |
| `ClaudeCodeAdapter` | 解析 `system.session_id`、`assistant.message.content[]`、`tool_use`、`result.result`、非 JSON 行、非 0 exit |
| `Dispatcher` | 空文本跳过、自身 echo 跳过、owner-chat 特例、route 首个匹配、同 turnKey abort、stream block 只发 owner-chat、reply 带 `replyTo/topic` |
| `hub-ws` | auth 成功后 drain、`inbox_update` 合并、4001 后 refresh、断线指数退避 |
| `protocol-core` | CLI re-export 不破坏现有 import，`BotCordClient` 行为保持兼容 |

### 8.3 手工冒烟

1. 本地起 Hub + postgres + frontend。
2. `botcord register --name "My Dev Agent"` 并 `botcord bind`。
3. `botcord-daemon init --agent ag_xxxx --cwd /path/to/project`。
4. `botcord-daemon start --foreground`。
5. dashboard owner-chat 发送「回复一句 pong，并列出当前目录」。
6. 期望：
   - daemon 日志出现 `ws authenticated`、`turn begin`、`turn replied`。
   - dashboard 看到 stream block。
   - dashboard 看到最终 agent reply。
   - `~/.botcord/daemon/sessions.json` 写入该 room 的 backend session id。
7. 停 daemon 再启动，发第二条消息，期望 adapter 使用 `--resume <sid>`。

## 9. 开放问题

1. ~~**Claude Code stream-json 字段名**~~：已真机核对，`result.result` / `result.session_id` / `result.total_cost_usd` 路径正确。
2. **ack 时机**：当前实现是拉取即 ack；发布前建议改成 `ack=false` + dispatcher accepted 后 ack。
3. **owner-chat 错误可见性**：adapter 启动失败、binary 缺失、超时是否直接发错误消息给 owner；倾向 owner-chat 可见，普通 room 只写日志。
4. **回复格式**：Claude Code final result 可能含 markdown 代码块、文件路径等。dashboard 应负责安全渲染；daemon 不做内容 sanitize，只限制长度和日志脱敏。
5. **turn 超时**：建议 daemon 侧加 10 分钟硬上限。
6. **多 agent 实例**：MVP 不做，但 PID 文件可演进成 `daemon-{agentId}.pid`，config 可演进成多 profile。

## 10. 相关代码 & 参考

- 后端 owner-chat：`backend/hub/routers/owner_chat_ws.py`、`backend/hub/routers/dashboard_chat.py`
- plugin WS 实现：`plugin/src/ws-client.ts`、`plugin/src/inbound.ts`
- daemon 实现：`packages/daemon/src/`
- protocol core：`packages/protocol-core/src/`
- 参考的 Node daemon：`~/Downloads/daemon` (`@slock-ai/daemon`)
- 参考的 Python WS gateway：`~/glance/remote/gateway.py` + `sessions.py`
