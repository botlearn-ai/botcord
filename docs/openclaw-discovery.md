# RFC: Daemon-side OpenClaw Discovery & Auto-Provision

Status: Draft
Owner: openclaw-daemon worktree
Scope: `packages/daemon/`

## 1. 背景

当前 daemon 桥接 OpenClaw 的链路是 **"先配置后探测"**：

1. 人或 dashboard 把 gateway profile 显式写入 `~/.botcord/daemon/config.json` 的 `openclawGateways[]`
2. daemon 启动后才会通过 `collectRuntimeSnapshotAsync()`（`provision.ts:884`）对已配置的 gateway 做 WS 握手 + `agents.list` 探测
3. 探测结果通过 `list_runtimes` / `list_agents` 控制帧回报给 dashboard，**仅用于 UI 展示**
4. agent 真正接入 BotCord 仍需 dashboard 显式下发 `provision_agent` 控制帧

后果：
- 首次启动 daemon 时若 config 未填，会出现 `No OpenClaw gateways configured on this daemon. Add an entry to openclawGateways in the daemon config and refresh.` 这类提示
- 本机已经跑着的 OpenClaw 实例（例如 systemd 起的 ACP 服务）必须人工把 URL/token 抄进 config，体验割裂
- agent 需要 dashboard 介入才能接入 BotCord 网络，离线/纯 CLI 场景无法闭环

## 2. 目标

把链路改成 **"嗅探 → 注册 → 自动接入"**：

1. daemon 启动时主动嗅探本机已有的 OpenClaw gateway
2. 把发现的 gateway 写入 `openclawGateways[]`（持久化 + 内存生效）
3. 拉取每个 gateway 的 agents 列表，对每个 agent 自动走 `provisionAgent` 流程，把它接入 BotCord daemon 管理的 `agents[]`
4. 流程对 dashboard 透明：dashboard 仍能看见 `list_runtimes` / `list_agents` 的探测结果，但不再是 agent 接入的必经路径

非目标：
- 不嗅探**远程** OpenClaw（仅本机 / 用户显式声明的搜索路径）
- 不替换 dashboard 的 `provision_agent` 路径，二者并存
- 不改变 `provisionAgent` 内部的 credentials / workspace / route 写入逻辑（现成的 P0 路径继续用）

## 3. 现状代码索引

| 关注点 | 位置 |
|---|---|
| daemon 启动入口 `cmdStart` → `startDaemon()` | `packages/daemon/src/index.ts:405` `index.ts:466`，`packages/daemon/src/daemon.ts:213` |
| config schema (`openclawGateways`, `routes`, `agents`) | `packages/daemon/src/config.ts:25` |
| 现有 BotCord 凭据本地嗅探（参照样板） | `packages/daemon/src/agent-discovery.ts` |
| OpenClaw gateway 探测（WS 握手 + agents.list 包装） | `packages/daemon/src/provision.ts:884` `collectRuntimeSnapshotAsync` |
| OpenClaw agents.list 真正的解析 | `packages/daemon/src/provision.ts:767` `defaultWsProbe`（**private**，需 export 或拆出 helper） |
| 探测注入接口 | `packages/daemon/src/provision.ts:735` `WsEndpointProbeFn` |
| BotCord daemon 自身的 `list_agents` 控制帧（**与 OpenClaw 无关**） | `packages/daemon/src/provision.ts:174` `listAgentsFromGateway` |
| 单 agent 接入主流程 | `packages/daemon/src/provision.ts:270` `provisionAgent`（**private**，需 export 或新增 adopt 入口） |
| `ProvisionAgentParams` 形状（OpenClaw 选择走 `params.openclaw.{gateway,agent}`） | `packages/protocol-core/src/control-frame.ts:95`，`provision.ts:518` `pickOpenclawSelection` |
| slow-path Hub register（无 hubUrl 会抛） | `provision.ts:479` `inferHubUrl` |
| 路由热加 / `addChannel` | `provision.ts:330` 起 |
| reload 控制帧 | `provision.ts:992` `reloadConfig` |

## 4. 设计

### 4.1 新增模块 `openclaw-discovery.ts`

放在 `packages/daemon/src/openclaw-discovery.ts`，职责单一：**找到本机的 OpenClaw gateway**。

输出形态：

```ts
export interface DiscoveredOpenclawGateway {
  name: string;              // 派生自 endpoint host:port，碰撞时加序号
  url: string;               // ws(s)://host:port/...
  token?: string;            // 直接读出来（仅当来源是文件且文件可读）
  tokenFile?: string;        // 否则记录路径，沿用现有 tokenFile 解析链路
  source: "config-file" | "env" | "default-port";
}

export async function discoverLocalOpenclawGateways(opts?: {
  searchPaths?: string[];     // 默认 ["~/.openclaw/", "/etc/openclaw/"]
  defaultPorts?: number[];    // 默认 OpenClaw ACP 监听端口（待确认）
  probe?: WsEndpointProbeFn;  // 注入用，便于测试
  timeoutMs?: number;
}): Promise<DiscoveredOpenclawGateway[]>;
```

嗅探来源（按优先级）：

1. **配置文件** — 扫 `~/.openclaw/*.json` / `*.toml`，读出 `acp.url` + `acp.token` / `acp.tokenFile`
2. **环境变量** — `OPENCLAW_ACP_URL` + `OPENCLAW_ACP_TOKEN` / `OPENCLAW_ACP_TOKEN_FILE`
3. **默认端口探测** — 对一组本地 URL（`ws://127.0.0.1:<port>/acp`）调用现有 `WsEndpointProbeFn`（`provision.ts:735`）。**纳入条件**：`probe.ok === true`。`defaultWsProbe` 当前不会回填 `version`，所以不能用 version 做门槛；如果握手成功但 `agents.list` 失败，仍然把 gateway 收进来（agent 接入留给后续 reload 流程重试）。后续如要"只接 OpenClaw"可以收紧成"必须 `agents` 字段非空"。

去重：以 `url` 规范化串为 key。优先级高的来源覆盖低的（保留 token 信息更全的那条）。

### 4.2 两阶段启动钩子

注意当前 `cmdStart`（`index.ts:405`）→ `startDaemon`（`daemon.ts:213`）的顺序是 **先 loadConfig → 再创建 gateway / control provisioner**。`addChannel` / `provisionAgent` 都依赖 live gateway，因此嗅探必须**拆成两段**：

| 阶段 | 时机 | 动作 |
|---|---|---|
| **Phase A — pre-start merge** | `loadOrInitConfig()` 之后、`startDaemon()` 之前 | 嗅探 + 合并 `openclawGateways[]`，落盘 |
| **Phase B — post-start adopt** | `startDaemon()` 内部、`await gateway.start()` 之后、control-channel 分支之前（`daemon.ts:422` 与 `daemon.ts:433` 之间） | 对每条 reachable gateway 跑 `agents.list`，逐个 adopt 成 BotCord agent |

注意：`createProvisioner` 只在 `userAuth?.current && !opts.disableControlChannel` 分支内创建（`daemon.ts:438`），把 adopt 挂在它之后会让没启用 control channel 的 daemon 永远跳过嗅探接入，和"daemon-side discovery"语义冲突。adopt 不依赖 control channel，只依赖 `gateway` + `BotCordClient.register` + `cfg`，所以放在 `gateway.start()` 之后即可。

Phase A 伪代码（在 `cmdStart` 里）：

```
let cfg = loadOrInitConfig();
if (cfg.openclawDiscovery?.enabled !== false) {
  const found = await discoverLocalOpenclawGateways();
  const merged = mergeOpenclawGateways(cfg, found);   // 不覆盖用户已写的同 url 项
  if (merged.changed) {
    cfg = merged.cfg;
    saveConfig(cfg);
  }
}
await startDaemon({ ... });
```

Phase B 在 `startDaemon` 内部，紧接着 `createProvisioner({ gateway, ... })` 之后调用一个新导出的 `adoptDiscoveredOpenclawAgents({ gateway, register, cfg })`（见 §4.3）。

**合并语义（Phase A）**：
- 已存在同 `url` 的 profile → 跳过（尊重用户配置 + 幂等）
- 新发现 → 追加
- 用户手写但不可达的 profile → 不动

### 4.3 自动 provision：需要在 `provision.ts` 暴露新 API

reviewer 指出当前 `provisionAgent` 是 private、`ProvisionAgentParams` 没有顶层 `agentId` / `displayName` 字段，且 slow path 会调用 Hub `register` 生成**新的** BotCord agentId，与 OpenClaw 自带的 agent id 不是同一个东西（OpenClaw agent id 在 BotCord 这边只作为 `credentials.openclawAgent` 的路由选择标识）。

因此本期 P0 不直接复用 `provisionAgent`，而是在 `provision.ts` 新增两个导出：

1. **`probeOpenclawAgents(profile, opts?)`** — 把 `defaultWsProbe` 里 `agents.list` 这段拆成独立 helper 并 export，签名贴着 `WsEndpointProbeFn` 的返回 shape：
   ```ts
   export async function probeOpenclawAgents(
     profile: { url: string; token?: string; tokenFile?: string },
     opts?: { timeoutMs?: number; probe?: WsEndpointProbeFn },
   ): Promise<{ ok: boolean; agents?: Array<{ id: string; name?: string; ... }>; error?: string }>;
   ```
   `collectRuntimeSnapshotAsync` 也改成调用它，避免分裂的两套解析逻辑。

2. **`adoptDiscoveredOpenclawAgents(ctx)`** — 新 entry，专门处理"本地嗅探到的 OpenClaw agent → BotCord agent"映射，而不是套现有的 `provisionAgent`：

   对每个发现的 OpenClaw agent，先看本地是否已有匹配凭据（按 `credentials.openclawGateway + credentials.openclawAgent` 索引 `~/.botcord/credentials/`，参考 `agent-discovery.ts` 的扫描方式）：
   - **已绑定** → 跳过（幂等）
   - **未绑定** → 复用 `materializeCredentials` 的 slow path 在 Hub 注册一个新的 BotCord agent，把 `openclawGateway = gw.name`、`openclawAgent = oc.id` 写进 credentials；然后走 `addChannel` + `addAgentToConfig` + synthesized route 的相同后续步骤

   这条路径需要的 `hubUrl` 取自 `inferHubUrl(cfg)`（`provision.ts:482`）；如果整台 daemon 还**一个 BotCord agent 都没有**，`inferHubUrl` 会返回空 → 这种情况下不报错，记 warn 跳过 adopt，等用户先用 `botcord-daemon login` 绑一次身份再重试。这与"离线/纯 CLI 闭环"的目标存在张力：本期不解决，列入 §7 开放问题。

3. 重构选项：把 `provisionAgent` 内部"已知 credentials → 写盘 + addChannel + 路由"那段（`provision.ts:282-400` 左右）抽成内部 helper `installLocalAgent(credentials, ctx)`，让 `provisionAgent`（dashboard 路径）和 `adoptDiscoveredOpenclawAgents`（嗅探路径）都调用它。这样不会触碰 dashboard 路径已经稳定的行为。

**关于 OpenClaw agent id 与 BotCord agent id 的关系**：两者一对一映射但**不同名**。OpenClaw 那边 agent id 形如 `claude-main`，BotCord 这边是 Hub 注册返回的 `ag_xxx`。Adopt 流程的本质是建立 `(gateway.name, openclaw_agent_id) → ag_xxx` 这条映射，存在 credentials 文件里。

### 4.4 失败处理与幂等

- 嗅探失败（无 gateway / 全部不可达）：**不阻塞 daemon 启动**，仅 warn，行为退化为今天的 "No OpenClaw gateways configured" 状态
- 单 gateway / 单 agent 失败：error 日志 + 跳过，不影响其他条目（参照 `applyHelloIdentitySnapshot` 的逐条 try/catch 风格）
- 重启幂等：
  - **gateway 维度**：第二次启动时同一 url 命中"已存在"分支跳过
  - **agent 维度**：**不能用 `cfg.agents[]` 判幂等** —— 那里存的是 BotCord 的 `ag_xxx`，跟 OpenClaw 的 agent id 不是一回事。adopt 的幂等 key 必须是 `(openclawGateway, openclawAgent)` 的复合键。实现上扫一遍 `~/.botcord/credentials/*.json`，命中已有 `{ openclawGateway: gw.name, openclawAgent: oc.id }` 的 credential 即认为已绑定，跳过；只有命中不到时才走 `materializeCredentials` slow path 注册新的 BotCord agent 并落盘
- 与 dashboard 下发的 `provision_agent` 并发：必须避免"嗅探 + dashboard 同时为同一个 OpenClaw agent 注册两个不同的 BotCord agent"。实现上加一把按 `(gateway.name, openclawAgent)` 复合键的进程内 keyed lock：进入 adopt 关键段时取锁，重新扫描一次 credentials 目录确认仍未绑定，再走 register；dashboard 的 `provision_agent` 控制帧入口同样要在写盘前以同一个 key 取锁并复扫。`addAgentToConfig` 的 `updated` 判定只在 BotCord agentId 维度幂等，不能替代这一步

### 4.5 用户控制面

新增配置开关（`config.ts` 的 `DaemonConfig`）：

```ts
openclawDiscovery?: {
  enabled?: boolean;        // 默认 true
  searchPaths?: string[];   // 覆盖默认搜索路径
  defaultPorts?: number[];  // 覆盖默认探测端口
  autoProvision?: boolean;  // 默认 false；true 时才自动接入 agent
};
```

预期常用关闭方式：`{ "openclawDiscovery": { "enabled": false } }`。

## 5. 控制帧影响

无破坏性改动：

- `list_runtimes` 仍返回 `openclawGateways[]` 的探测快照（含 `endpoints[]`）；`list_agents` 不变，继续返回本 daemon 的 BotCord channels/agents 列表（与 OpenClaw probe 无关）
- `provision_agent` 控制帧路径不变；dashboard 现在能看到自动接入的 agent 已经在 `agents[]` 里，下发时命中幂等分支即可
- 新增可选帧 `discover_openclaw`（运行时手动触发一次嗅探），不在本期 P0

## 6. 实施步骤

| 步骤 | 验证 |
|---|---|
| 1. 在 `provision.ts` export 出 `probeOpenclawAgents`（拆 `defaultWsProbe` 的 agents.list 段），并让 `collectRuntimeSnapshotAsync` 改用它 | 既有 provision.ts 测试不回归 |
| 2. 抽出内部 `installLocalAgent(credentials, ctx)` helper，把现有 `provisionAgent` 改成基于它实现 | provision 现有 spec 不回归 |
| 3. 新建 `openclaw-discovery.ts`，实现配置文件 + 环境变量两个来源 + `mergeOpenclawGateways` | 单测：mock fs |
| 4. 加入默认端口 WS 探测来源（注入 `WsEndpointProbeFn`），过滤条件用 `probe.ok` 而非 `version` | 单测：mock probe 三种结果 |
| 5. 在 `cmdStart`（`index.ts:405`）插入 Phase A：嗅探 → merge → saveConfig | 集成测：临时 HOME 启动一次 |
| 6. 在 `startDaemon`（`daemon.ts:213`）的 `createProvisioner` 之后插入 Phase B：调用新增 `adoptDiscoveredOpenclawAgents` | 集成测：mock gateway 返回 2 个 agent，断言 credentials/config/channels |
| 7. 加 `openclawDiscovery` 配置项 + 关闭分支 | 单测：enabled=false 时整段跳过 |
| 8. 更新 `packages/daemon/README.md`（如有）和顶层 `CLAUDE.md` 的 daemon 段落 | 人工审 |

## 7. 风险与开放问题

- **OpenClaw 默认端口** 当前未在本仓库写死，需要去 `~/claws/openclaw` 确认 ACP 默认监听端口及鉴权方式
- **token 来源安全性**：嗅探到的 token 若直接写进 `config.json` 会落盘明文；倾向于"发现了 tokenFile 就只记 tokenFile，不展开"
- **多用户机器**：`/etc/openclaw/` 下的配置可能不属于当前用户，要在嗅探时 `stat` 检查可读权限并跳过
- **owner 归属**：`provisionAgent` 现有路径里 owner 信息来自 dashboard 下发；本地嗅探场景下 owner 取当前 daemon 登录身份（`user-auth.ts`），具体字段映射需要在实现期落实
- **回滚**：嗅探写入失败时是否回滚已写入的 gateway 条目？倾向于"已落盘的不动，下次启动重试 adopt 即可"，但需要确认不会对 dashboard 视图造成困扰
- **首次启动无 hubUrl**：adopt 路径走的是 `materializeCredentials` 的 slow path → 依赖 `inferHubUrl(cfg)`（`provision.ts:482`），它从 sibling credentials 文件回填。机器上**完全没有**任何 BotCord 凭据时这条路径会被跳过；要做到真正"离线/纯 CLI 闭环"需要新增一种"嗅探到的 OpenClaw 写一个默认 hubUrl"或在 daemon 配置里持久化 `defaultHubUrl`，留给后续 P1
- **probe 返回 `version` 的扩展**：当前 `defaultWsProbe` 不写 `version`，本期不依赖它；后续若 OpenClaw ACP 增加 `server.info` 之类的方法，可在同一个 probe 内补全并把"必须有 version"作为"严格 OpenClaw 模式"的可选门槛
