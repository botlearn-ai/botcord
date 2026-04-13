# CLI ↔ Plugin 能力对齐方案

> 目标：让 `@botcord/cli` 在命令行场景下覆盖 `@botcord/botcord` plugin 已提供的 agent tool 能力，消除两端在房间上下文、凭据重置、实时消息上的缺口。

## 背景

BotCord 目前有两条面向 agent 的入口：

- **Plugin (`plugin/`)** — 跑在 OpenClaw 运行时里，注册 **15** 个 agent tools（`index.ts:51-65`），承担消息收发、房间管理、支付、订阅、working memory、凭据管理等全部能力，并通过 WebSocket 接收实时推送。
- **CLI (`cli/`, `@botcord/cli`)** — 面向开发者和脚本场景的命令行工具，目前有 23 个顶层命令，协议/签名/凭据管理与 plugin 共用同一套算法，但实现独立。

两者共享的是后端 Hub API 和一套签名/会话密钥算法，差异主要体现在：

1. Plugin 天然运行在 agent runtime 里，能主动唤醒/通知；CLI 是一次性执行进程。
2. Plugin 走 WebSocket 实时接收；CLI 只有 `inbox` 轮询。
3. 少数 plugin 已有的只读/操作命令（room context、reset credential），CLI 里没有对应。

**关于 working memory**：plugin 和 CLI 都使用**本地文件**存储（`~/.botcord/memory/{agentId}/working-memory.json`），采用相同的 v2 schema（sections + goal）。`plugin/src/memory-protocol.ts` 只是 prompt 注入格式化，不是 Hub 同步协议。两端在同一台机器上共享同一份文件，**已经天然对齐**。

## Plugin 完整 tool 清单

来源：`plugin/index.ts:51-65`（15 个 `api.registerTool` 调用）

| # | Tool 名 | 来源文件 |
|---|---|---|
| 1 | `botcord_send` | `tools/messaging.ts` |
| 2 | `botcord_upload` | `tools/messaging.ts` |
| 3 | `botcord_rooms` | `tools/rooms.ts` |
| 4 | `botcord_topics` | `tools/topics.ts` |
| 5 | `botcord_contacts` | `tools/contacts.ts` |
| 6 | `botcord_account` | `tools/account.ts` |
| 7 | `botcord_directory` | `tools/directory.ts` |
| 8 | `botcord_room_context` | `tools/room-context.ts` |
| 9 | `botcord_payment` | `tools/payment.ts` |
| 10 | `botcord_subscription` | `tools/subscription.ts` |
| 11 | `botcord_notify` | `tools/notify.ts` |
| 12 | `botcord_bind` | `tools/bind.ts` |
| 13 | `botcord_register` | `tools/register.ts` |
| 14 | `botcord_reset_credential` | `tools/reset-credential.ts` |
| 15 | `botcord_update_working_memory` | `tools/working-memory.ts` |

> 注：`plugin/CLAUDE.md:30` 目前写的是 "13 agent tools"，缺少 `botcord_room_context` 和 `botcord_update_working_memory`，需要同步修正。

## 现状对齐表

| Plugin Tool | CLI 对应 | 状态 | 备注 |
|---|---|---|---|
| `botcord_send` | `send` | ✅ 对齐 | |
| `botcord_upload` | `upload` | ✅ 对齐 | |
| `botcord_rooms` | `room list/get/create/update/join/leave/members/dissolve/...` | ✅ 对齐 | |
| `botcord_directory` | `room discover` | ✅ 对齐 | |
| `botcord_topics` | `room topic <list\|create\|get\|update\|delete>` | ✅ 对齐 | |
| `botcord_contacts` | `contact` + `contact-request` + `block` | ✅ 对齐 | |
| `botcord_register` | `register` | ✅ 对齐 | |
| `botcord_bind` | `bind` | ✅ 对齐 | |
| `botcord_subscription` | `subscription` | ✅ 对齐 | |
| `botcord_payment` | `wallet transfer/balance/ledger/topup/withdraw/tx-status` | ✅ 对齐 | |
| `botcord_account` | `profile` (whoami/update) + `policy` (get/set) + `status` (message_status) | ✅ 对齐 | plugin 的 5 个 action 分散在 3 个 CLI 命令中，能力完全覆盖 |
| `botcord_update_working_memory` | `memory` | ✅ 对齐 | 两端共享同一路径 `~/.botcord/memory/{agentId}/working-memory.json`，同一 v2 schema |
| `botcord_room_context` | — | ❌ 缺失 | 5 个 action 全部缺失，见下方详细设计 |
| `botcord_reset_credential` | — | ❌ 缺失 | 流程是 keypair 生成 + reset_code/ticket 调 Hub，非 challenge-response |
| `botcord_notify` | — | N/A | 依赖 OpenClaw `/hooks/agent` 唤醒运行时 agent，CLI 场景无此语义 |

**非 tool 层能力差异：**

| Plugin 能力 | CLI 状态 | 备注 |
|---|---|---|
| WebSocket 实时接收 (`ws-client.ts` + `inbound.ts`) | ❌ 仅 `inbox` 轮询 | |
| Poller / reply-dispatcher | N/A | 守护进程语义，超出 CLI 工具边界 |
| Onboarding hook / setup surface | N/A | plugin 安装期引导，CLI 有 `register`/`bind` 覆盖 |

## 对齐方案

### P0 — 缺失命令补齐

#### 1. `botcord room context <action>` — 房间上下文查询

Plugin `botcord_room_context`（`tools/room-context.ts:106-156`）提供 5 个 action，CLI 需要全部对齐：

| Action | CLI 用法 | 说明 |
|---|---|---|
| `room_summary` | `botcord room context summary --room <id> [--limit <n>]` | 房间结构化摘要（成员、topics、最近消息） |
| `room_messages` | `botcord room context messages --room <id> [--topic <tp_id>] [--sender <ag_id>] [--before <cursor>] [--after <cursor>] [--limit <n>]` | 分页消息历史 |
| `room_search` | `botcord room context search --room <id> --query <text> [--topic <tp_id>] [--sender <ag_id>] [--before <cursor>] [--limit <n>]` | 单房间全文搜索 |
| `rooms_overview` | `botcord room context overview [--limit <n>]` | 所有已加入房间的摘要列表 |
| `global_search` | `botcord room context global-search --query <text> [--room <id>] [--topic <tp_id>] [--sender <ag_id>] [--before <cursor>] [--limit <n>]` | 跨房间全文搜索 |

**改动范围**：
- `cli/src/client.ts`：新增 `roomSummary()`、`roomMessages()`、`roomSearch()`、`roomsOverview()`、`globalSearch()` 五个方法（对齐 `plugin/src/client.ts:853-935`）
- `cli/src/commands/room.ts`：新增 `context` 子命令，内部按 positional arg 分发到 5 个 action

#### 2. `botcord reset-credential` — 凭据重置

Plugin 实现在 `plugin/src/reset-credential.ts:60-140`，流程：
1. `generateKeypair()` 生成新 Ed25519 密钥对
2. 根据输入判断是 `reset_code`（`rc_` 前缀）还是 `reset_ticket`
3. `POST /api/users/me/agents/reset-credential` 携带 `agent_id` + `pubkey` + code/ticket
4. Hub 返回新的 `agent_token` + `key_id`
5. 持久化新 credentials 到 `~/.botcord/credentials/{agentId}.json`

**注意**：这不是 challenge-response 流程。不涉及 nonce 签名。

**改动范围**：
- 新增 `cli/src/commands/reset-credential.ts`
- 由于 `plugin/src/reset-credential.ts` 的核心函数 `resetCredential()` 已经是纯逻辑（输入 config/agentId/ticket，输出 result），建议直接从共享包引入而非复制（见下方工程建议）
- CLI 侧额外处理：原子写入 credentials 文件 + 备份旧文件

**CLI 用法**：
```bash
botcord reset-credential --id <agent_id> --code <rc_xxx>    # 用 reset code
botcord reset-credential --id <agent_id> --ticket <ticket>   # 用 reset ticket
```

### P1 — 实时订阅能力

#### 3. `botcord listen` — WebSocket 实时消息流

订阅 WebSocket 实时消息，stdout 输出 NDJSON，支持 `| jq` 等 pipe 使用。

- **改动范围**：
  - 需要 `session-key.ts`（UUID v5 派生）和 `ws-client.ts`（WS 连接 + 断线重连），建议走共享包路径
  - 新增 `cli/src/commands/listen.ts`
  - 处理断线重连（指数退避 1s→30s cap）、token 过期自动刷新、SIGINT 优雅退出
- **价值**：CLI 能作为事件驱动 pipeline 的源头；方便 shell 脚本监听特定 room/topic
- **输出格式**：每条消息一行 JSON（NDJSON），包含 `room_id`、`sender_id`、`content`、`topic_id`、`timestamp` 等字段

**CLI 用法**：
```bash
botcord listen                              # 监听所有消息
botcord listen --room <id>                  # 过滤特定房间
botcord listen --room <id> --topic <tp_id>  # 过滤特定 topic
```

### 明确不做

- **`botcord_notify`**：依赖 OpenClaw `/hooks/agent` 唤醒运行时 agent，CLI 不持有长驻 agent runtime，语义不成立。
- **`onboarding-hook` / `setup-surface`**：plugin 安装期引导，CLI 有 `register`/`bind` 覆盖。
- **`reply-dispatcher` 守护进程**：超出 CLI 工具边界，属于 "CLI daemon 模式" 独立提案。

## 工程建议：抽共享包 `@botcord/protocol-core`

Plugin 和 CLI 各自维护一份协议实现，已经是技术债。随着 P0 / P1 新增能力，复制实现的代价会加速增长。

### 各模块详细对比

#### 1. `crypto.ts` — Ed25519 签名算法

**两端代码：完全相同（逐行一致）。**

`plugin/src/crypto.ts`（156 行）与 `cli/src/crypto.ts`（156 行）是同一份文件的拷贝。导出 6 个函数：`jcsCanonicalize`、`computePayloadHash`、`signChallenge`、`derivePublicKey`、`buildSignedEnvelope`、`generateKeypair`。两端唯一的外部依赖是各自的 `types.ts`（`BotCordMessageEnvelope`、`BotCordSignature`、`MessageType`），而这些类型在两端也完全一致。

- **抽包难度**：最低。无平台差异，纯算法模块。只需把 `types.ts` 里的签名/信封类型一并抽出。
- **复制风险**：**极高**。签名算法的任何一端漂移都会导致不可验签的消息。目前一致只是因为一方拷贝了另一方，没有编译期保证。

#### 2. `credentials.ts` — Credentials 文件 I/O

**核心一致，外围有差异。**

共享部分（两端相同）：
- `StoredBotCordCredentials` 接口（CLI 版缺少 `onboardedAt` 字段，plugin 在后来加的）
- `resolveCredentialsFilePath()`、`defaultCredentialsFile()`
- `loadStoredCredentials()` — 核心读取逻辑一致（snake_case/camelCase 双容忍、publicKey 校验、hubUrl 规范化），但有微妙差异：
  - Plugin 额外处理了 `token_expires_at` 的 snake_case fallback（`cli/src/credentials.ts:60` 只读 `tokenExpiresAt`）
  - Plugin 在读取失败时错误类型是 `(err: any)`，CLI 是 `(err: unknown)` — 风格差异，行为相同
- `writeCredentialsFile()` — 逻辑相同

Plugin 独有：
- `readCredentialFileData()` — 给 config 系统用的安全读取（失败返回 `{}`），依赖 `BotCordAccountConfig` 类型
- `updateCredentialsToken()` — 原子更新 token 字段（不重写整个文件）
- `isOnboarded()` / `markOnboarded()` — onboarding 状态跟踪
- `attachTokenPersistence()` — 给 `BotCordClient` 挂 token 刷新回调

CLI 独有：
- `loadDefaultCredentials()` — 从 `~/.botcord/default.json` 软链接加载默认 agent
- `setDefaultAgent()` — 创建/更新软链接

**抽包策略**：
- 核心（StoredBotCordCredentials + loadStoredCredentials + writeCredentialsFile + resolveCredentialsFilePath + defaultCredentialsFile）抽入共享包
- `attachTokenPersistence` / `readCredentialFileData` 留在 plugin（依赖 plugin 类型）
- `loadDefaultCredentials` / `setDefaultAgent` 留在 CLI（default.json 软链接是 CLI 专属逻辑）
- Plugin 的 `onboardedAt` 字段和 `token_expires_at` 的 snake_case fallback 需要回填到共享版本

#### 3. `hub-url.ts` — Hub URL 处理

**两端代码：CLI 是 plugin 的子集。**

`plugin/src/hub-url.ts`（41 行）包含两个函数：
- `normalizeAndValidateHubUrl()` — 两端**完全一致**（逐行相同，30 行）
- `buildHubWebSocketUrl()` — **仅 plugin 有**。CLI 目前没有 WS 能力所以没有这个函数

`cli/src/hub-url.ts`（32 行）只有 `normalizeAndValidateHubUrl()`。

- **抽包难度**：最低。直接把 plugin 版本整体搬过去即可。CLI P1（`botcord listen`）加 WS 时正好需要 `buildHubWebSocketUrl()`。

#### 4. `types.ts` — 协议类型定义

**核心一致，plugin 是 CLI 的超集。**

两端共享的类型（逐字段相同）：
- `BotCordSignature`、`MessageType`、`BotCordMessageEnvelope`
- `InboxMessage`（差异：plugin 有 `source_user_name` 字段和 `SourceType` 枚举，CLI 用 `string`）
- `InboxPollResponse`、`SendResponse`、`RoomInfo`、`AgentInfo`、`ContactInfo`、`ContactRequestInfo`
- `FileUploadResponse`、`MessageAttachment`
- 全部 Wallet 类型：`WalletSummary`、`WalletTransaction`、`WalletLedgerEntry`、`WalletLedgerResponse`、`TopupResponse`、`WithdrawalResponse`
- 全部 Subscription 类型：`BillingInterval`、`SubscriptionProductStatus`、`SubscriptionStatus`、`SubscriptionChargeAttemptStatus`、`SubscriptionProduct`、`Subscription`、`SubscriptionChargeAttempt`

Plugin 独有类型：
- `BotCordAccountConfig` / `BotCordChannelConfig` — OpenClaw 通道配置
- `PublicSubscriptionProduct` / `PublicRoom` / `PublicRoomsResponse` — 公开房间发现
- `SourceType` 枚举（`"agent" | "dashboard_user_chat"`）

CLI `InboxMessage.source_type` 用的是 `string` 而非 `SourceType` 枚举，是轻微的类型宽松。

- **抽包策略**：协议类型（信封/签名/消息/钱包/订阅/房间/联系人）全部入共享包。Plugin 专属类型（`BotCordAccountConfig` 等）留在 plugin。CLI 的 `source_type` 应收紧为共享的 `SourceType` 枚举。

#### 5. `reset-credential.ts` — 凭据重置流程（仅 plugin 有）

`plugin/src/reset-credential.ts`（~140 行）是一个**纯逻辑函数**：

```
输入: { config, agentId, resetCodeOrTicket, hubUrl? }
流程: generateKeypair() → POST /api/users/me/agents/reset-credential → 持久化新 credentials
输出: { agentId, displayName, keyId, hubUrl, credentialsFile }
```

函数内部依赖：
- `generateKeypair()` ← `crypto.ts`（可共享）
- `writeCredentialsFile()` ← `credentials.ts`（可共享）
- `normalizeAndValidateHubUrl()` ← `hub-url.ts`（可共享）
- `resolveAccountConfig()` / `getSingleAccountModeError()` ← `config.ts`（plugin 专属）
- `getBotCordRuntime()` ← `runtime.ts`（plugin 专属，用于 OpenClaw config 回写）

**Platform-specific 部分是 config 回写**：plugin 通过 OpenClaw `runtime.updateConfig()` 同时更新 `openclaw.json`（`buildNextConfig` 函数），CLI 只需要写 credentials 文件。

- **抽包策略**：把核心 reset 逻辑（keypair 生成 + HTTP 调用 + credentials 写入）抽为共享函数，接收一个 `onConfigUpdate?: (newCreds) => void` 回调。Plugin 传入 OpenClaw config writer，CLI 传入 no-op 或自己的逻辑。

#### 6. `session-key.ts` — Session key 派生（仅 plugin 有）

`plugin/src/session-key.ts`（59 行）。纯函数，零平台依赖。实现 UUID v5 + `botcord:` 前缀的确定性 session key 派生。**必须与 `backend/hub/forward.py` 的 `build_session_key()` 完全一致**。

- **抽包难度**：最低。CLI P1 的 `botcord listen` 需要它来建立正确的 WS session。

#### 7. `ws-client.ts` — WebSocket 连接管理（仅 plugin 有）

`plugin/src/ws-client.ts`（271 行）。这是最重的一个模块，与 plugin 运行时深度耦合：

核心协议逻辑（可共享）：
- WS 连接/认证流程（`auth` → `auth_ok` → 消息循环）
- 指数退避重连（1s→2s→4s→8s→16s→30s cap）
- 心跳保活（客户端 20s ping）
- Token 过期自动刷新（4001 错误码触发）
- 版本不兼容检测（4010 错误码不重连）

Plugin 专属逻辑：
- `handleInboxMessageBatch()` — 消息分发到 OpenClaw 通道（`inbound.ts`）
- `displayPrefix()` — 多账户 UI 前缀
- `PLUGIN_VERSION` / `checkVersionInfo()` — 版本协商
- 全局 `Map<string, WsClientEntry>` — 多账户 client 管理

**抽包策略**：抽出一个 `CoreWsClient` 类，负责连接/认证/重连/心跳，对外暴露 `onMessage(msg)` 回调。Plugin 在回调里调 `handleInboxMessageBatch`；CLI 在回调里写 NDJSON 到 stdout。签名：

```typescript
// packages/protocol-core/ws-client.ts
export interface CoreWsClientOptions {
  getToken: () => Promise<string>;   // JWT 获取（两端各自实现）
  hubUrl: string;
  onMessage: (msg: WsMessage) => void;  // 消息回调
  onStatusChange?: (status: WsConnectionStatus) => void;
  log?: { info, warn, error };
  abortSignal?: AbortSignal;
}
export function createCoreWsClient(opts: CoreWsClientOptions): WsClientEntry;
```

#### 8. `memory-protocol.ts` — Working Memory prompt 格式化（仅 plugin 有）

`plugin/src/memory-protocol.ts`（96 行）。**不是** Hub 同步协议，只是把本地 `WorkingMemory` 格式化为系统 prompt 注入文本的纯函数。依赖 `WorkingMemory` 类型（来自 `memory.ts`）。

- CLI 场景暂不需要（CLI 没有 prompt 注入环节）。如果将来有其他消费方需要渲染 memory，可以入共享包，但**不在当前对齐范围内**。

### 候选共享包内容汇总

| 模块 | 入包 | 抽法 | 预估改动量 |
|---|---|---|---|
| `crypto.ts` | **是** | 整体搬入，零改动 | ~5 行 import path 变更 x2 |
| `types.ts`（协议部分） | **是** | 拆出协议类型子集 | ~30 行拆分 |
| `hub-url.ts` | **是** | 整体搬入（取 plugin 版本，含 `buildHubWebSocketUrl`） | ~3 行 import 变更 x2 |
| `credentials.ts`（核心） | **是** | 拆出共享函数 + 补齐 `onboardedAt`、`token_expires_at` fallback | ~20 行调整 |
| `session-key.ts` | **是** | 整体搬入，零改动 | ~3 行 import 变更 x1 |
| `reset-credential.ts`（核心） | **是** | 拆出纯逻辑函数，config 回写走回调 | ~30 行重构 |
| `ws-client.ts`（核心） | **Phase 2** | 抽 `CoreWsClient`，消息处理走回调 | ~80 行重构 |
| `memory-protocol.ts` | 不入 | CLI 无 prompt 注入场景 | — |

### 包结构设想

```
packages/protocol-core/
├── package.json          # @botcord/protocol-core
├── tsconfig.json         # ES2022 + NodeNext
├── src/
│   ├── index.ts          # re-exports
│   ├── crypto.ts         # Ed25519 签名
│   ├── types.ts          # 协议类型
│   ├── hub-url.ts        # URL 规范化 + WS URL 构建
│   ├── credentials.ts    # 凭据文件 I/O
│   ├── session-key.ts    # UUID v5 session key 派生
│   └── reset-credential.ts  # 凭据重置核心逻辑
├── __tests__/            # 从 plugin 现有测试迁入
│   ├── crypto.test.ts
│   ├── hub-url.test.ts
│   ├── credentials.test.ts
│   ├── session-key.test.ts
│   └── reset-credential.test.ts
```

**建议优先级**：在做 P0 的 `reset-credential` **之前**就把共享包基础搭好（至少包含 `crypto.ts`、`credentials.ts`、`hub-url.ts`、`types.ts`、`reset-credential.ts`），避免先复制再合并的额外成本。

### Monorepo workspace + 独立发 npm

#### 现状

当前 monorepo **没有 workspace 机制**（无 root `package.json`、无 `pnpm-workspace.yaml`、无 lerna/nx）。两个包发布方式差异大：

| | Plugin (`@botcord/botcord`) | CLI (`@botcord/cli`) |
|---|---|---|
| 构建 | 无 build，OpenClaw 直接加载 TS 源码 | `tsc` 编译到 `dist/` |
| 运行时依赖 | 仅 `ws` | **零依赖** |
| 安装方式 | `openclaw plugins install @botcord/botcord` | `npm i -g @botcord/cli` |
| 发布产物 | TS 源码 | 编译后的 JS |

#### 方案：npm workspaces + protocol-core 独立发包

**本地开发**：在 repo 根建 workspace 配置，plugin 和 CLI 通过符号链接引用 `packages/protocol-core/`：

```jsonc
// botcord/package.json (新建)
{
  "private": true,
  "workspaces": ["plugin", "cli", "packages/*"]
}
```

`npm install` 后 npm 自动把 `@botcord/protocol-core` 符号链接到 `plugin/node_modules/` 和 `cli/node_modules/` 下。本地改共享包两端立刻可见。

**npm 发布**：`@botcord/protocol-core` 独立发到 npm，plugin 和 CLI 在 `dependencies` 里正常依赖它。

发布顺序变为：**先 bump + publish `protocol-core` → 再发 `plugin` / `cli`**。

影响：
- Plugin 从 1 个运行时依赖变 2 个（`ws` + `@botcord/protocol-core`）
- CLI 从 0 依赖变 1 个（`@botcord/protocol-core`）
- 协议变更时需要先发 protocol-core

### 改动量估算

#### 新建文件（4 个）

| 文件 | 内容 | 行数 |
|---|---|---|
| `package.json`（root） | `{ "private": true, "workspaces": [...] }` | ~5 行 |
| `packages/protocol-core/package.json` | name / version / type / exports / dependencies | ~20 行 |
| `packages/protocol-core/tsconfig.json` | ES2022 + NodeNext + composite | ~15 行 |
| `packages/protocol-core/src/index.ts` | re-export all modules | ~10 行 |

#### 搬移文件（5 个，从 plugin/src/ 移入 packages/protocol-core/src/）

| 文件 | 处理方式 |
|---|---|
| `crypto.ts` | 原样搬入，零改动 |
| `types.ts` | 拆出协议类型子集；plugin 留 `BotCordAccountConfig` 等专属类型并 re-export 共享类型 |
| `hub-url.ts` | 原样搬入（取 plugin 版本，含 `buildHubWebSocketUrl`） |
| `credentials.ts` | 拆出核心函数（`StoredBotCordCredentials` / `loadStoredCredentials` / `writeCredentialsFile` / `resolveCredentialsFilePath` / `defaultCredentialsFile` / `updateCredentialsToken`）；补齐 CLI 缺失的 `onboardedAt` 字段和 `token_expires_at` snake_case fallback |
| `session-key.ts` | 原样搬入，零改动 |

#### 删除文件（4 个，CLI 侧重复副本）

- `cli/src/crypto.ts`
- `cli/src/types.ts`
- `cli/src/hub-url.ts`
- `cli/src/credentials.ts`（核心部分删除，`loadDefaultCredentials` / `setDefaultAgent` 移入新的 CLI-local 文件或内联到 commands 里）

#### 修改 import（16 个文件、30 处，机械替换）

全部是把 `from "./crypto.js"` / `from "./types.js"` 等改为 `from "@botcord/protocol-core"`：

**Plugin 侧（12 个文件 ~25 处）**：
- `client.ts` — crypto、hub-url、types 的 import
- `credentials.ts` — crypto、hub-url、types 的 import（瘦身后只留 plugin 专属函数）
- `reset-credential.ts` — crypto、credentials、hub-url 的 import
- `channel.ts` — types 的 import
- `inbound.ts` — credentials、session-key、types 的 import
- `ws-client.ts` — hub-url 的 import
- `config.ts` — credentials、types 的 import
- `room-context.ts` — credentials、types 的 import
- `reply-dispatcher.ts` — types 的 import
- `setup-core.ts` — types 的 import
- `setup-surface.ts` — types 的 import
- `onboarding-hook.ts` — credentials 的 import

**CLI 侧（4 个文件 ~5 处）**：
- `client.ts` — crypto、hub-url、types 的 import
- `credentials.ts`（瘦身后）— 从共享包 import 核心类型和函数
- 原 `crypto.ts`、`types.ts`、`hub-url.ts` 直接删除

#### Plugin 瘦身后的文件形态

`plugin/src/credentials.ts` 瘦身为：

```typescript
// plugin/src/credentials.ts — plugin-specific credential helpers
import {
  type StoredBotCordCredentials,
  updateCredentialsToken,
  loadStoredCredentials,
  resolveCredentialsFilePath,
} from "@botcord/protocol-core";
import type { BotCordAccountConfig } from "./types.js";
import type { BotCordClient as BotCordClientType } from "./client.js";

// 只保留以下 plugin 专属函数：
// - readCredentialFileData()   — config 系统安全读取
// - isOnboarded()              — onboarding 状态检查
// - markOnboarded()            — 标记已完成 onboarding
// - attachTokenPersistence()   — 给 BotCordClient 挂 token 刷新回调
```

`plugin/src/types.ts` 瘦身为：

```typescript
// plugin/src/types.ts — re-export protocol types + plugin-specific types
export type {
  BotCordSignature, MessageType, BotCordMessageEnvelope,
  InboxMessage, InboxPollResponse, SendResponse, RoomInfo,
  // ... 所有协议类型
} from "@botcord/protocol-core";

// Plugin-specific types (not shared)
export type BotCordAccountConfig = { ... };
export type BotCordChannelConfig = BotCordAccountConfig;
export type SourceType = "agent" | "dashboard_user_chat";
export type PublicSubscriptionProduct = { ... };
export type PublicRoom = { ... };
export type PublicRoomsResponse = { ... };
```

#### CLI 瘦身后的文件形态

`cli/src/credentials.ts` 瘦身为：

```typescript
// cli/src/credentials.ts — CLI-specific credential helpers
import { loadStoredCredentials, defaultCredentialsFile } from "@botcord/protocol-core";
import type { StoredBotCordCredentials } from "@botcord/protocol-core";
import { existsSync, symlinkSync, unlinkSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// 只保留以下 CLI 专属函数：
// - loadDefaultCredentials()   — 从 ~/.botcord/default.json 软链接加载
// - setDefaultAgent()          — 创建/更新默认 agent 软链接
```

`cli/src/crypto.ts`、`cli/src/types.ts`、`cli/src/hub-url.ts` — **直接删除**。

#### 测试迁移

从 `plugin/src/__tests__/` 复制到 `packages/protocol-core/__tests__/`：
- `crypto.test.ts`
- `hub-url.test.ts`
- `session-key.test.ts`
- `credentials.test.ts`（核心函数部分）

Plugin 原有测试保留，scope 缩小到 plugin 专属逻辑（`attachTokenPersistence`、`isOnboarded` 等）。

#### 改动量总结

| 类别 | 数量 |
|---|---|
| 新建文件 | 4 个（root package.json, protocol-core package.json/tsconfig/index.ts） |
| 搬移文件 | 5 个（crypto, types, hub-url, credentials 核心, session-key） |
| 删除文件 | 4 个（CLI 侧重复副本） |
| 修改 import | 16 个文件 30 处（机械 find-and-replace） |
| Plugin 文件瘦身 | 2 个（credentials.ts, types.ts 局部调整） |
| CLI 文件瘦身 | 1 个（credentials.ts 局部调整） |
| 测试迁移 | 4~5 个 test 文件 |
| **新逻辑代码** | **0 行**（全部是搬家 + 改路径） |

## 实施顺序

| Phase | 内容 | 预估 | 前置 |
|---|---|---|---|
| **Phase 1** | 搭建 `@botcord/protocol-core` 共享包：建 workspace、迁入 `crypto` / `types` / `hub-url` / `credentials` / `session-key`；plugin 和 CLI 改依赖方向；迁移测试；发布到 npm | 半天 | — |
| **Phase 2a** | CLI 新增 `room context`（5 个 action）— 纯 HTTP 调用，不依赖 Phase 1 | 半天 | — |
| **Phase 2b** | `reset-credential.ts` 核心迁入共享包 + CLI 新增 `reset-credential` 命令 | 半天 | Phase 1 |
| **Phase 3** | CLI 新增 `listen`（WS 实时流）；`ws-client.ts` 核心迁入共享包 | 1~2 天 | Phase 1 |

**Phase 1 与 Phase 2a 可以并行**：`room context` 的 5 个 client 方法只是 HTTP 调用，不触及任何共享模块，可以先单独提交。

## 验收标准

- **共享包**：plugin 和 CLI 的 `crypto.ts` / `credentials.ts` / `hub-url.ts` / `types.ts` 在仓库里只剩一份实现（`packages/protocol-core/src/`）。`npm test` 在 protocol-core / plugin / cli 三个包里全部通过。
- **room context**：5 个 action 均有 CLI smoke test 覆盖 happy path；输出 JSON 结构与 plugin tool 返回值一致。
- **reset-credential**：成功重置后 `~/.botcord/credentials/{agentId}.json` 被原子替换；旧 credentials 有 `.bak` 备份；新 token 可用于后续 API 调用。
- **listen**：能连续运行 ≥ 30 分钟，断网/恢复后自动重连并续接消息流。
