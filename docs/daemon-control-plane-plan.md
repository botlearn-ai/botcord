# Daemon Control Plane Plan

**Status**: Draft
**Date**: 2026-04-23
**Scope**: 设计 daemon 与 Hub 之间的控制面通道，支持 Hub 下发 provision agent 等管理指令，并定义 daemon 的用户身份登录流程。

---

## 1. Background

当前架构（见 `gateway-module-plan.md`）：

```
┌──────────────── daemon 进程 ────────────────┐
│  CLI / config / memory / snapshot           │
│           │                                 │
│           ▼                                 │
│  ┌──── Gateway (库) ────┐                   │
│  │  Dispatcher          │                   │
│  │  ChannelManager      │                   │
│  │  SessionStore        │                   │
│  │                      │                   │
│  │  channels:           │                   │
│  │   ├─ botcord(ag_A) ─► WS ─► Hub          │
│  │   ├─ botcord(ag_B) ─► WS ─► Hub          │
│  │   └─ botcord(ag_C) ─► WS ─► Hub          │
│  └──────────────────────┘                   │
└─────────────────────────────────────────────┘
```

- `daemon` 是进程壳：CLI、配置、持久化、进程生命周期
- `gateway` 是功能库：路由、调度、session、channel / runtime 抽象
- 每个 agent 通过 gateway 内的一条独立 BotCord WS 与 Hub 通信（1 agent = 1 WS，仅承载数据面）

现有链路只有**数据面**（agent ↔ Hub 的消息收发）。缺少**控制面** —— Hub 无法主动下发"在某台机器上新建一个 agent 实例"之类的管理指令。

## 2. Goals

- Hub 可以主动触达特定用户名下的 daemon，下发管理指令（provision agent、revoke agent、reload config、ping 等）。
- 控制面连接的生命周期独立于任何 agent，不受 agent 增删影响。
- 0 agent 的全新 daemon 也能接收控制指令（解决 bootstrap）。
- 一台 daemon 的首次使用体验：`botcord-daemon start` 一条命令搞定，必要时自动触发登录。
- 新能力不污染 gateway 模块（`packages/daemon/src/gateway/`）的抽象 —— gateway 仍然只管数据面 channel。

## 3. Non-Goals

- 本文不设计多 daemon 之间的协调（同一用户多台机器），仅要求 Hub 能区分每条 daemon 连接。
- 不讨论控制帧的业务语义细节（具体有哪些管理命令、各自参数），只定义管道与分发机制。
- 不触动现有 agent 数据面 WS 的协议，agent 的消息收发继续走 `channels/botcord.ts`。

## 4. Key Design Decisions

### 4.1 独立控制连接，不复用 agent WS

**决定**：daemon 另开一条独立 WS 承载控制面，不和任何 agent WS 复用。

**理由**：

- Bootstrap：0 agent 时没有任何 agent WS，Hub 无法下发"创建第一个 agent"。
- 生命周期解耦：agent 被删/被吊销不能影响控制通道。
- 权限清晰：agent WS 认证用 agent token，控制 WS 认证用用户/daemon token，鉴权面不混。
- 协议演进独立：控制帧可以和数据面消息协议各自发展。

### 4.2 控制连接用"用户身份"，不是"agent 身份"

**决定**：daemon 的控制 WS 以**用户身份**连接 Hub，不绑定任何 agent。

**理由**：

- daemon 的语义是"用户在这台机器上的本地代理"，不是某个 agent 自己。
- agent 是用户拥有的资源；用 owner 身份操作自己的 agent 天然合理。
- 和后端 `app/` BFF 层的 Supabase 用户鉴权模型对齐，不用额外发明"daemon 专属身份"的授权关系。
- 多机支持顺理成章：同一用户在笔记本/台式机/服务器各跑一个 daemon，Hub 看到的是"用户 X 的 N 台机器"。

### 4.3 控制面由 daemon 独占，不进 gateway

**决定**：控制 WS 的建立、认证、重连、帧分发**全部在 daemon 外壳实现**，不下沉到 gateway 模块（`src/gateway/`）。

**理由**：

- 控制 WS 不产出 inbound message、不接 runtime，不属于"channel"抽象。
- gateway 保持"消息协议适配器"的纯净边界，便于在非 daemon 宿主里复用。
- daemon 本来就持有用户凭据、磁盘路径、进程控制，是控制面的自然归属。

### 4.4 `start` 一条命令，必要时内联登录

**决定**：不拆 `login` / `start` 两个子命令。`botcord-daemon start` 运行时：

- 有有效凭据 → 直接启动。
- 无凭据 / refresh 失效 → 在 fork 到后台**之前**，前台走设备码登录流程，完成后继续启动。
- 无 TTY（systemd、Docker、CI）→ 立刻报错退出，提示用户先在终端跑一次。

**理由**：

- 减少用户记忆的子命令数，符合"零仪式感"的 UX 目标。
- 登录必须在 fork 之前完成（fork 后 stdio 丢失，用户看不到 device code）。
- 非交互环境降级为报错，避免后台进程卡住。

## 5. Architecture

### 5.1 逻辑图

```
┌──────────────────── daemon 进程 ────────────────────┐
│                                                     │
│  ~/.botcord/daemon/user-auth.json                   │
│       │ (refresh token + access token)              │
│       ▼                                             │
│  control-channel ───────── WS(user token) ──► Hub  │ ← 控制面
│       │                                             │   1 条
│       │ 收到 control frame:                          │
│       ▼                                             │
│  provision.ts                                       │
│       │                                             │
│       ├─► @botcord/protocol-core.registerAgent()    │
│       ├─► fs: ~/.botcord/credentials/{ag}.json      │
│       ├─► fs: ~/.botcord/daemon/config.json         │
│       └─► gateway.addChannel(ag)                    │
│                                                     │
│  ┌──── Gateway ────┐                                │
│  │                 │                                │
│  │  channels:      │                                │
│  │   ├─ botcord(ag_A) ─── WS(agent token) ─► Hub  │ ← 数据面
│  │   ├─ botcord(ag_B) ─── WS(agent token) ─► Hub  │   N 条
│  │   └─ botcord(ag_C) ─── WS(agent token) ─► Hub  │
│  └─────────────────┘                                │
└─────────────────────────────────────────────────────┘
```

### 5.2 模块职责

| 层 | 模块 | 职责 |
|----|------|------|
| 用户鉴权 | `daemon/src/user-auth.ts` (新增) | 加载/保存 `user-auth.json`、设备码登录、refresh token 续期 |
| 控制通道 | `daemon/src/control-channel.ts` (新增) | 维持用户身份的 WS、心跳/重连、验签、分发控制帧 |
| Provisioner | `daemon/src/provision.ts` (新增) | 执行控制帧对应的业务（建 agent、吊销、热装配） |
| 协议原语 | `@botcord/protocol-core` (扩展) | 新增 `DaemonClient`、设备码端点封装、控制帧类型 |
| Gateway 扩展 | `daemon/src/gateway/` (扩展) | 新增 `addChannel(cfg)` / `removeChannel(id)` 增量 API |
| Hub 后端 | `backend/hub/` (扩展) | 新增 `/daemon/auth/*`、`/daemon/ws` 端点，daemon_instances 表 |
| Dashboard | `frontend/` (扩展) | 新增 `/activate` 页面，登录态下输入 device code 授权 |

### 5.3 职责分工的三层分流

控制帧从 Hub 到业务执行跨三层：

```
Hub
  │  control frame (type=provision_agent, sig=...)
  ▼
control-channel.ts    ← 识别帧类型、验签
  │
  ▼
provision.ts          ← 业务执行：注册 agent + 写盘 + addChannel
  │
  ▼
gateway.addChannel()  ← 纯装配，无磁盘 IO
```

## 6. 认证流程

### 6.1 首次启动（无凭据）

```
$ botcord-daemon start

[daemon] no credentials, starting device code flow...

→ 本机请求 Hub:
    POST /daemon/auth/device-code
← Hub:
    {
      device_code: "dc_xxx_secret",                       // 机密，仅 daemon 保存
      user_code: "ABCD-EFGH",                             // 短码，可展示
      verification_uri:          "https://app.botcord.dev/activate",
      verification_uri_complete: "https://app.botcord.dev/activate?code=ABCD-EFGH",
      expires_in: 600,             // 10 min
      interval: 5                  // 轮询间隔（秒）
    }

本机打印:
    ➜ Open this URL in your browser:
      https://app.botcord.dev/activate?code=ABCD-EFGH

    Or visit https://app.botcord.dev/activate and enter code: ABCD-EFGH
    Waiting...

（可选）本机尝试自动打开浏览器（open / xdg-open / start）；失败或非 TTY 时仅打印 URL。

→ 本机按 interval 轮询 Hub:
    POST /daemon/auth/device-token
    { device_code: "dc_xxx_secret" }
← Hub: 用户未操作    → { status: "pending" }
← Hub: 用户已授权    → {
      access_token: "...",         // 短期（1h）
      refresh_token: "...",        // 长期
      expires_in: 3600,
      user_id: "usr_xxx",
      daemon_instance_id: "dm_xxx",
      hub_url: "..."
    }

本机落盘 ~/.botcord/daemon/user-auth.json (chmod 0600)
本机打印 "Logged in as susan.wang@ouraca.ai"
本机继续原 start 流程（fork 或前台）
```

**URL 字段的安全边界**（参照 RFC 8628 §3.3.1）：

| 字段 | 能放进 URL 吗 | 原因 |
|------|---------------|------|
| `user_code`（`ABCD-EFGH`） | ✅ 可以 | 短码、低熵，离开 `device_code` 无法单独换 token |
| `device_code`（`dc_xxx_secret`） | ❌ 绝对不可 | 机密凭据，泄漏等同盗用本次授权 |

用户在浏览器侧（`/activate?code=ABCD-EFGH`）：

1. 前端从 query 读 `code`，**预填**到输入框（不自动提交）
2. 未登录 → 跳 Supabase 登录，带 `return_to=/activate?code=ABCD-EFGH`
3. 已登录 → 展示"Authorize daemon on this device?"+ **显式 Approve 按钮**
4. 点 Approve → `POST /daemon/auth/device-approve { user_code }`，Hub 把 `user_code` 绑到当前 `user_id` 并生成 `daemon_instance_id`
5. 下一次 daemon 轮询 `device-token` 返回 access/refresh token

**关键：预填 ≠ 自动授权**。URL 可能经过浏览器历史、shell 历史、剪贴板监控、屏幕分享泄漏，"点击即授权"会把 OAuth 退化成单因素。必须保留 Supabase 登录态校验 + 用户显式点击确认两道关卡；URL 里的 `code` 只是省去手输。

### 6.2 后续启动（有效凭据）

```
$ botcord-daemon start

  [daemon] refreshing access token... ok
  [daemon] connecting to Hub control channel... ok
  daemon started (pid 12345)
```

- 如果 `access_token` 5 分钟内过期 → 用 `refresh_token` 到 `/daemon/auth/refresh` 换新
- 连 `/daemon/ws` 时 header 带 `Authorization: Bearer <access_token>`

### 6.3 运行中凭据失效

daemon 已在后台跑，用户突然在 dashboard 吊销了这台机器：

- 后台子进程下次 refresh 收到 401
- 写 error log + 写一个 `~/.botcord/daemon/auth-expired.flag`
- `botcord-daemon status` 显示 "credentials revoked, run `botcord-daemon start` again"
- 控制面 WS 断开并停止重连（避免对 Hub 造成无效请求），gateway 的 agent 数据面 WS **不中断**（仍持有各自 agent token，可继续收发消息）

### 6.4 非交互环境

```
$ botcord-daemon start   # 在 systemd / Docker / CI 环境
error: not logged in and no TTY available
hint:  run `botcord-daemon start` once interactively to establish credentials,
       or mount a valid ~/.botcord/daemon/user-auth.json
exit 1
```

检测手段：`process.stdin.isTTY === false`。

## 7. Disk Layout

```
~/.botcord/
├── daemon/
│   ├── config.json             # 已有：agents, routes, cwd 等
│   ├── user-auth.json          # 新增：refresh/access token   chmod 0600
│   ├── auth-expired.flag       # 新增：运行时标记凭据失效      chmod 0600
│   ├── daemon.pid              # 已有
│   └── snapshot.json           # 已有
├── credentials/
│   ├── ag_A.json               # 已有：agent keypair          chmod 0600
│   └── ag_B.json
└── ...
```

`user-auth.json` 结构：

```json
{
  "userId": "usr_xxx",
  "daemonInstanceId": "dm_xxx",
  "hubUrl": "https://hub.botcord.dev",
  "accessToken": "...",
  "refreshToken": "...",
  "expiresAt": 1745712000000
}
```

**权限必须 `0600`**：Node 写文件时指定 `{ mode: 0o600 }`，读时校验 `stat().mode & 0o077 === 0`，不合规直接拒绝启动并提示用户 chmod。

## 8. 控制帧协议（骨架）

### 8.1 分类

| 类别 | 示例 | 方向 |
|------|------|------|
| Provisioning | `provision_agent` / `revoke_agent` | Hub → daemon |
| 配置 | `reload_config` / `set_route` | Hub → daemon |
| 状态查询 | `list_agents` / `get_snapshot` / `list_runtimes` | Hub → daemon，daemon 回执 |
| 健康 | `ping` / `pong` | 双向 |
| 事件上报 | `agent_provisioned` / `config_changed` / `runtime_snapshot` | daemon → Hub |

### 8.2 帧结构（草案）

```ts
interface ControlFrame {
  id: string;                    // 请求 id，用于 ack/幂等去重
  type: string;                  // 帧类型
  params?: Record<string, unknown>;
  sig?: string;                  // Hub 侧签名（服务端 → daemon 时必填）
  ts: number;                    // 毫秒时间戳，防重放
}

interface ControlAck {
  id: string;                    // 对应 request id
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
```

### 8.3 安全要求

- **Hub → daemon** 的控制帧必须带 Hub 签名，daemon 用内置 Hub 公钥验签才执行。
- **请求 id 幂等**：provisioner 维护最近 N 条 request id，重复直接返回原结果，防重放。
- **时间戳窗口**：`abs(now - ts) > 5min` 拒绝。
- **参数白名单**：`provision_agent` 的 `cwd` 只允许用户家目录下的路径；禁止 `/etc`、`/root` 等。

### 8.4 端到端链路：前端创建 Agent（典型 provision_agent）

这是控制面的**第一个业务用例**，也是 §11.1 P0 的主验证路径。完整链路跨越前端 / Hub / daemon 三层：

> `params.runtime` 的落地（Hub `agents.runtime` 列、daemon credentials cache、router 兜底）单列在 [`agent-runtime-property-plan.md`](./agent-runtime-property-plan.md)，本节的 provision 链路图继续作为上层叙述入口。

```
┌─ 浏览器 ─┐        ┌─ Hub ─┐                ┌─ daemon (dm_xxx) ─┐
│ [+] New Agent     │        │                │                    │
│   on: [MacBook ▼] │        │                │                    │
│   label: "writer" │        │                │                    │
└──POST─────┼───────►        │                │                    │
 /api/me/agents/provision    │                │                    │
 { daemon_id, label, cwd? }  │                │                    │
            │                 │                │                    │
            │  ① BFF 鉴权     │                │                    │
            │   daemon.user=me│                │                    │
            │   daemon.online?│                │                    │
            │                 │                │                    │
            │                 │ ② 构造控制帧   │                    │
            │                 │   sign + push  │                    │
            │                 │────WS─────────►│  control-channel   │
            │                 │ provision_agent│    ↓ dispatch      │
            │                 │                │                    │
            │                 │                │  ③ provision.ts    │
            │                 │                │   a. gen keypair   │
            │                 │                │   b. POST /agents/ │
            │                 │                │      register      │
            │                 │                │   c. 落盘 creds     │
            │                 │                │   d. 改 config.json│
            │                 │                │   e. addChannel    │
            │                 │                │                    │
            │                 │◄────WS─────────│  ④ ControlAck      │
            │                 │ ok,{agent_id}  │                    │
            │◄──HTTP 200──────│                │                    │
 UI: "Agent online ✓"         │                │                    │
```

#### 设计决策

**目标 daemon 选择**：前端下拉列出用户名下所有 daemon_instance + 在线状态（`last_seen_at` + 活跃控制 WS）。离线 daemon 置灰。

**离线降级**：daemon_instance 无活跃控制 WS → Hub BFF 直接返回 `409 daemon_offline`。**不排队延迟执行** —— 避免"几天后才开机、参数语境已变"的幽灵任务；用户可改走 bind_code 流程，或先 `botcord-daemon start` 再重试。

**回执等待（UX）**：provision 涉及多次 I/O（keypair → Hub → 磁盘 → WS），不是瞬时操作。采用**混合**方案：
- Hub BFF 在 WS 上等 ControlAck，≤5s 内到 → HTTP 同步返回 agent
- 超时 → 立即返回 `{ job_id }`，前端切换为轮询 `/api/jobs/{id}` 或订阅 WS 推送

大多数场景走同步路径，UX 最佳。

**事务性与回滚**（§12 风险表的具体落地）：

| 失败点 | 状态 | 处理 |
|--------|------|------|
| a. keypair 生成 | 本地纯计算 | 不会失败 |
| b. POST /agents/register | 两边都没状态 | ack error，前端弹报错 |
| c. 写 credentials 落盘 | **Hub 有 agent，本地没凭据** | daemon ack error → Hub 自动调 `revoke_agent` 保持一致 |
| d. gateway.addChannel | 凭据已落盘 | 不回滚；下次 daemon 启动自愈（重建 WS） |

写盘用"临时目录 → fsync → rename 到正式位置"防掉电。

**鉴权链路的两处新需求**：

1. **Hub 签发控制帧的签名必须 P0 就落实**（§8.3 里写了但要前置）：`sig` + Hub 公钥内置到 daemon，否则任何劫持控制 WS 的中间人都能下发 `provision_agent`。
2. **agent 注册新增"daemon user-token 代发"路径**：现在 `POST /agents/register` 凭 bind_code 或 challenge-response。daemon provision 时 daemon 持 user access_token，后端要允许 "user access_token + 归属该 user 的 daemon_instance_id" 作为注册凭证，绕过 bind_code。

#### 与现有 bind_code 机制的关系

两条链路**互补共存**，不替代：

| 场景 | 走哪条 |
|------|--------|
| 用户已装 daemon、想在自己机器上集中管理 agent | **daemon provision**（本节） |
| 没装 daemon 的轻量场景（临时 AI、CI、同事机器） | bind_code（既有） |
| 把任意 AI 进程临时赋身份 | bind_code（既有） |

前端复用策略：`AgentBindDialog` 加一条分支 —— 若用户名下存在活跃 daemon 则默认"在某台 daemon 上创建"，展开 daemon 下拉；否则回退到 bind_code + prompt 复制。

### 8.5 Runtime Discovery（daemon 本地可用的 AI CLI）

§8.4 创建对话框要回答"这台机器能跑什么 runtime"（claude-code / codex / gemini / ...）。daemon 侧 `detectRuntimes()` 已能枚举本地 CLI 并给出 `{ available, path, version }`；问题是**如何把这份信息上行到 Hub 和前端**。

采用 **Push + Pull 混合**方案：

#### 推：daemon 主动上报快照

```ts
// daemon → Hub, 事件上报
{
  type: "runtime_snapshot",
  params: {
    runtimes: [
      { id: "claude-code", available: true,  version: "2.1.118", path: "/usr/local/bin/claude" },
      { id: "codex",       available: true,  version: "0.122.0", path: "/opt/homebrew/bin/codex" },
      { id: "gemini",      available: false }
    ],
    probed_at: 1745712000000
  }
}
```

触发时机：

| 时机 | 行为 |
|------|------|
| 控制 WS 首次连上 | 立即 probe + push |
| 控制 WS 重连（网络中断后） | 重 probe + push（覆盖旧快照） |
| 定时（每 30 min） | 重 probe；diff 上次结果，**变化时才 push**（避免空转） |
| daemon 收到 `list_runtimes`（拉模式兜底） | 重 probe + ack，同时 push 到 Hub 缓存 |

#### 拉：Hub 按需下发强制刷新

```ts
// Hub → daemon, 状态查询
{ type: "list_runtimes" }
// daemon ack: { ok: true, result: { runtimes: [...], probed_at: ... } }
```

只用于前端"刷新"按钮的用户显式触发，不作为常规路径。

#### Hub 侧缓存

快照落到 `daemon_instances` 表（§9.3 新增两列）：

- `runtimes_json JSONB` —— 最近一次完整快照
- `runtimes_probed_at TIMESTAMPTZ` —— 探测时间

**为什么落库而非只内存**：daemon 离线时前端仍要能看见这台机器"上次检测到什么 runtime"，用来展示离线 daemon 的"装了 claude-code + codex"标签，UX 远好于一片空白。代价只是一行 JSONB（几 KB）。

#### 前端 UX

`GET /api/users/me/daemons` 返回含 runtime：

```json
[
  {
    "id": "dm_mac",
    "label": "MacBook Pro",
    "online": true,
    "last_seen_at": "2026-04-23T10:15:00Z",
    "runtimes": [
      { "id": "claude-code", "available": true,  "version": "2.1.118" },
      { "id": "codex",       "available": true,  "version": "0.122.0" },
      { "id": "gemini",      "available": false }
    ],
    "runtimes_probed_at": "2026-04-23T10:15:00Z"
  },
  {
    "id": "dm_home",
    "label": "Home Server",
    "online": false,
    "last_seen_at": "2026-04-23T08:20:00Z",
    "runtimes": [
      { "id": "claude-code", "available": true, "version": "2.1.100" }
    ],
    "runtimes_probed_at": "2026-04-23T08:20:00Z"
  }
]
```

创建对话框中只展示 `available: true` 的 runtime，用户选一个塞进 `provision_agent` 的 `params.runtime`。离线 daemon 展示为灰色但保留已知 runtime 标签。`params.runtime` 如何在 Hub / daemon 两侧持久化，详见 [`agent-runtime-property-plan.md`](./agent-runtime-property-plan.md)。

可选端点（前端"刷新"按钮）：

```
POST /api/users/me/daemons/{id}/refresh-runtimes
→ Hub 下发 list_runtimes → ≤5s 等 ack → 返回最新快照
```

#### 不做的事

- ❌ **监听 PATH / 文件系统变化**：代价大、跨平台坑多、价值低。用户装了新 CLI 几十分钟内会被 30 min 定时扫到，急用就点刷新。
- ❌ **跨 daemon 聚合决策**：Hub 不做"这个 agent 该放在哪台机器"的自动推荐，选机器交给用户。

## 9. Hub 后端变更

### 9.1 新增端点

**Daemon 鉴权 / 控制面（daemon 自己调）**：

```
POST /daemon/auth/device-code        # 签发 device_code + user_code
POST /daemon/auth/device-token       # 轮询换 token（pending / issued）
POST /daemon/auth/device-approve     # 浏览器侧：已登录用户绑定 user_code
POST /daemon/auth/refresh            # 用 refresh_token 换新 access_token
GET  /daemon/ws                      # 控制面 WS（Bearer access_token）
```

**前端 BFF（浏览器调，Supabase JWT 鉴权）**：

```
POST /api/users/me/agents/provision              # 触发 §8.4 链路：Hub 代为下发 provision_agent
                                                 # body: { daemon_instance_id, label, runtime, cwd? }
                                                 # 同步返回 agent（≤5s）或 job_id（超时）
GET  /api/users/me/daemons                       # 列出 daemon_instance + 在线状态 + runtime 快照 (§8.5)
POST /api/users/me/daemons/{id}/refresh-runtimes # 强制 Hub 下发 list_runtimes，返回最新快照
DELETE /api/users/me/daemons/{id}                # 吊销某台机器（refresh_token 失效 + 关闭控制 WS）
```

**Agent 注册路径扩展**（现有 `POST /agents/register`）：

```
新增一种注册凭证：daemon user access_token + 归属该 user 的 daemon_instance_id
→ 绕过 bind_code，专供 §8.4 daemon provision 链路使用
```

### 9.2 Dashboard 端

- 新页面 `/activate`：
  - 未登录 → 先走 Supabase 登录
  - 已登录 → 输入框 + "授权 daemon" 按钮 → 调 `POST /daemon/auth/device-approve`
- 新页面 `/settings/daemons`：
  - 列出当前用户名下所有已授权的 daemon_instance
  - 每条显示 label（首次授权时可命名，如 "MacBook Pro"）、last_seen_at
  - "吊销"按钮 → 把对应 refresh_token 标记失效

### 9.3 新增表

```sql
CREATE TABLE daemon_instances (
  id                  VARCHAR PRIMARY KEY,   -- dm_xxx
  user_id             VARCHAR NOT NULL,
  label               VARCHAR,
  refresh_token_hash  VARCHAR NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  last_seen_at        TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  runtimes_json       JSONB,                 -- §8.5 最近一次 runtime_snapshot
  runtimes_probed_at  TIMESTAMPTZ            -- §8.5 探测时间；离线后仍保留
);
```

`refresh_token_hash` 存哈希而非明文，防库泄漏。

### 9.4 Token 策略

- **access_token**：JWT，claim 含 `user_id` + `daemon_instance_id`，1h 过期
- **refresh_token**：长随机串，存库哈希，长期有效直到被吊销
- 控制 WS 校验用 access_token，和 agent WS 走的 agent token 完全分开

## 10. Gateway 扩展

gateway 需要新增两个 API 支持"不停机增删 agent"：

```ts
class Gateway {
  // 已有
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  snapshot(): GatewayRuntimeSnapshot;

  // 新增
  addChannel(cfg: GatewayChannelConfig): Promise<void>;
  removeChannel(id: string): Promise<void>;
}
```

`ChannelManager` 内部对应增补 `startOne(adapter)` / `stopOne(id)`；现有 `startAll / stopAll` 实现改为循环调这俩。

**约束**：这两个 API 不碰磁盘、不做协议鉴权，只做"把一个已构造好的 channel 挂上/摘下"。所有身份、配置、credentials 写盘仍由 daemon 在调用前完成。

## 11. 实现路径

### 11.1 P0：最小可用

目标：跑通 §8.4 完整链路 —— 前端点"创建 agent" → Hub 推 `provision_agent` → daemon 建新 agent 并上线数据面 WS。

1. gateway 增量 API：`addChannel` / `removeChannel`
2. daemon 新增 `user-auth.ts` + 简陋的 `login --token <粘贴>` 路径（不做设备码）
3. daemon 新增 `control-channel.ts`，连 `/daemon/ws`；**Hub 控制帧签名校验必须 P0 落地**（§8.3）
4. daemon 新增 `provision.ts`，支持 `provision_agent` / `revoke_agent`，含 §8.4 的事务性与回滚
4a. daemon 控制 WS 首次连上时推一次 `runtime_snapshot`（§8.5 最小版：仅首连推，定时/重连/变化侦测留给 P1）；Hub 写入 `daemon_instances.runtimes_json`
5. Hub 新增 `/daemon/auth/*`（除 device-code 外的）、`/daemon/ws`、`daemon_instances` 表
6. Hub 新增 `POST /api/users/me/agents/provision` BFF 端点（§9.1），内部走控制 WS + 等 ack
7. Hub 扩展 `POST /agents/register`，接受 "daemon user access_token + daemon_instance_id" 作为注册凭证
8. Dashboard 两处：
   - "生成 daemon token"按钮用于粘贴（P0 替代设备码）
   - `AgentBindDialog` 新增"在 daemon 上创建"分支，调 `/api/users/me/agents/provision`

### 11.2 P1：交互登录

1. Hub 加 device-code 签发 + 轮询端点
2. Dashboard 新 `/activate` 页面
3. daemon `start` 内联设备码流程，替代 P0 的粘贴

### 11.3 P2：多 daemon 管理

1. Dashboard `/settings/daemons` 页面
2. daemon 启动时可带 `--label "MacBook"`，Hub 记入 daemon_instances
3. "吊销"能力从 dashboard 通过 Hub 推到目标 daemon

### 11.4 P3：扩展控制帧

基于已有管道新增 `reload_config` / `list_agents` / `set_route` 等指令，把现在通过 `botcord-daemon` CLI 本地执行的操作，也接到 dashboard UI。

## 12. 风险与取舍

| 风险 | 缓解 |
|------|------|
| 控制 WS 和数据 WS 同 Hub 但不同端点，实现成本翻倍 | 把 WS 帧路由/重连/keepalive 抽成共享工具，channels/botcord.ts 和 control-channel.ts 共用 |
| refresh_token 泄漏等于完全盗用 daemon | chmod 0600、考虑接入 macOS Keychain/libsecret；dashboard 提供吊销 |
| provision 中途失败（Hub 成功但本地写盘失败） | 事务化：先本地临时目录写 pending、Hub 成功后落正式位置、`addChannel` 失败则回滚 + 调 Hub revoke |
| 控制帧扩张后协议碎片化 | 严格 schema（zod/ajv）+ 版本号字段；daemon 拒绝未知 type 并上报 |
| 非交互环境用户困惑 | 错误信息直接给出下一步 hint；文档给出 systemd 单元示例（预先 login 后启 daemon service） |

## 13. 开放问题

- **控制 WS 和数据 WS 要不要走同一个 host？** —— 目前 `hub_url` 单一，倾向继续同 host，不同 path。
- **daemon_instance_id 的生命周期** —— 重装系统/换机器后旧 instance 怎么清？提供 dashboard 侧"查看并清理"。
- **多 agent 并发 provision** —— 同一时刻多条 `provision_agent` 到达，config.json 写入需加文件锁或串行队列。
- **跨 daemon 的 agent 迁移** —— 同一 agent 能否在 MacBook 和服务器之间转移？暂不支持，要求一个 agent 只绑一台 daemon。

---

## Appendix A：用户可见命令 UX

```
$ botcord-daemon start              # 有凭据：直启；无凭据：前台设备码 → 启
$ botcord-daemon start --foreground # 同上但不 fork
$ botcord-daemon start --relogin    # 强制走登录流程（偶尔用）
$ botcord-daemon stop
$ botcord-daemon status             # 含控制连接状态 + 当前登录用户
$ botcord-daemon logs [-f]
$ botcord-daemon config
$ botcord-daemon doctor
$ botcord-daemon route ...
$ botcord-daemon memory ...
```

无独立 `login` / `logout` 子命令。登出通过 dashboard 吊销完成。

## Appendix B：与现有文档的关系

- 扩展 `gateway-module-plan.md` 建立的 gateway/daemon 分层，新增控制面层。
- 不冲突 `daemon-agent-discovery-p1.md` 的 agent credentials 发现机制 —— 发现仍用本地文件扫描；provision 是"写入"这些文件，发现是"读取"。
- 不冲突 `daemon-context-migration-plan.md` 的 system context builder —— 控制面与消息数据面解耦，互不影响。
