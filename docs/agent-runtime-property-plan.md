# Agent Runtime Property Plan

**Status**: Draft
**Date**: 2026-04-23
**Scope**: 把 "runtime"（claude-code / codex / gemini / …）确立为 agent 的一等属性，定义它在 Hub 和 daemon 之间的持久化、下发和消费路径。补全 `daemon-control-plane-plan.md` §8.4 provision 链路里悬空的 `runtime` 字段落地。

---

## 1. Background

`daemon-control-plane-plan.md` §8.4 描绘的创建流程是：

> 前端下拉选 daemon → 选 runtime → 填 label → 提交 → Hub 下发 `provision_agent` → daemon 建 agent。

一个 daemon 可以托管**多个** agent（§5.1 拓扑图画的 ag_A / ag_B / ag_C 三个 agent 共用一条控制通道），每个 agent 有自己的身份、keypair、display_name —— 现在还要有自己的 **runtime**。

问题在于代码和文档之间有个缺口：

- `ProvisionAgentParams.adapter` 字段在 `packages/protocol-core/src/control-frame.ts:77` 存在，但 `packages/daemon/src/provision.ts:126` 的 `provisionAgent()` **完全没消费它**。
- daemon 侧 `DaemonConfig.defaultRoute.adapter` 和 `routes[].adapter`（`packages/daemon/src/config.ts:46,90`）目前承担 runtime 选择，但这是 "route 级别"（按 conversation 前缀 match）而非 "agent 级别"。
- Hub 侧 `agents` 表没有 runtime 列，`daemon_instances` 表只记录机器级别的 runtime 快照（§8.5 的 `runtimes_json`），**没有 agent ↔ runtime 的绑定**。

结果：用户在前端选的 runtime 既没落 Hub 也没真正落 daemon agent，只能隐式走 `defaultRoute`。

## 2. Goals

- Runtime 成为 agent 的稳定属性，创建时确定，生命周期内不轻易变更。
- Hub 是真相源：前端列 agent 时，即使目标 daemon 离线也能看到每个 agent 的 runtime 标签。
- daemon 侧持有本地 cache，启动不依赖 Hub 在线；离线也能正确路由 turn 到对应 CLI。
- 兼容现有的 route 模型（`defaultRoute` + `routes[]`），作为 per-conversation 覆盖保留给高级用户。
- 不引入新的漂移点：同一个事实不在 Hub 和 daemon 双写同步。

## 3. Non-Goals

- 不设计 runtime 的动态切换 UX —— 改 runtime 等同于销毁 + 重建 agent。
- 不讨论 runtime 本身的实现（adapter 抽象已在 `packages/daemon/src/gateway/runtimes/` 落地）。
- 不触动 daemon 本地 CLI 探测上报（§8.5 的 `runtime_snapshot`）—— 那个回答的是 "这台机器装了什么"，本方案回答 "这个 agent 用什么"。

## 4. Key Design Decisions

### 4.1 Runtime 是 agent 的属性，不是部署参数

**决定**：runtime 绑在 agent 上，Hub `agents` 表持久化。

**理由**：

- 前端语义上 "这是一个 claude-code agent" vs "这是一个 codex agent"，和 display_name / bio 一样是 agent 的身份标签。
- 即使 daemon 离线，dashboard 也要能列 agent 并显示 runtime —— 只存本地满足不了。
- 未来如果支持 agent 在多台机器间迁移，runtime 要求要跟着 agent 走。

**不选 "runtime 绑 daemon" 的原因**：一个 daemon 跑多个 agent，runtime 会各自不同；daemon 级别只有 "装了哪些 CLI" 是合理的（§8.5 已经覆盖）。

### 4.2 Hub 是 authoritative，daemon credentials.json 是 cache

**决定**：

- Hub `agents.runtime` 列是真相源；所有读取 agent 展示信息的前端接口都从这里读。
- daemon `~/.botcord/credentials/{ag}.json` 加 `runtime` 字段作为本地 cache，只由 Hub 下发 `provision_agent` 控制帧写入。daemon 自己不改。
- daemon 启动时不需要回 Hub 拉 —— credentials.json 已经够它决定如何路由 turn。

**理由**：

- 双写同步是漂移源，除非必要否则不引入。本方案中 Hub "写一次（创建时）"，daemon "读一次（存盘时）"，不是持续同步。
- daemon 离线运行是核心用户体验；任何强依赖 Hub 的启动流程都要拒绝。
- 改 runtime 不走 "PATCH agent.runtime"，走 revoke + provision 新 agent —— 所以 cache 不会失效。

### 4.3 运行时 route 决策：agent.runtime 做兜底

**决定**：daemon 启动时，把每个 agent 的 `credentials.runtime` 编译成一条 **终结性 route**（`match: { accountId: ag_id }`），**追加到用户显式 `cfg.routes` 之后**、`defaultRoute` 之前。运行时 `resolveRoute` 保持 match-first-wins 不变：

1. 遍历 `routes[]`（先用户显式，再启动时注入的 per-agent）→ 第一条 match 中即返回。
2. 全部 miss → `defaultRoute.adapter`（老配置兜底）。

**理由**：

- router.ts 保持纯函数，不读磁盘；"per-agent runtime" 的信息只在 boot 一次性注入（`toGatewayConfig` 的 `agentRuntimes` 参数）。
- 新创建的 agent 零配置就能跑它自己的 runtime —— 注入的 route 兜掉了 `defaultRoute`。
- `routes[]` 的显式规则仍然优先（追加在前），作为"某个 conversation 前缀换 runtime"这种高级场景保留。
- 老 credentials 没有 `runtime` 字段时不注入任何 route，行为与升级前一致。

### 4.4 Runtime 一经选定不可改

**决定**：没有 `PATCH agents/{id} { runtime }` 端点；要换 runtime 只能 revoke 旧 agent + provision 新 agent。

**理由**：

- 不同 runtime 的消息语义、context 组织方式、输出格式都不一样，历史消息混着不同 runtime 会造成上下文污染。
- 避免设计 "runtime migration" 这种高风险操作。
- agent id 是 pubkey 派生的 —— 换 runtime 后 id 变不变？索性都换掉，少一个判断分支。

## 5. Architecture

### 5.1 数据流

```
创建 agent:

前端 /settings/agents → [+ New]
  daemon:   [MacBook Pro ▼]
  runtime:  [claude-code ▼]    ← §8.5 runtime_snapshot 里 available:true 的集合
  label:    "writer"
  cwd:      ~/projects/blog
       │
       ▼
POST /api/users/me/agents/provision
  { daemon_instance_id, label, runtime, cwd }
       │
       ▼
Hub BFF:
  1. 鉴权 (user JWT → user_id)
  2. 验 daemon 归属 + 在线
  3. 验 runtime 在目标 daemon 的 runtime_snapshot 里 available
  4. 生成 keypair, 派生 ag_id
  5. INSERT agents(ag_id, user_id, daemon_instance_id, runtime, display_name=label, ...)
  6. 通过控制 WS 下发:
       { type: provision_agent,
         params: { runtime, cwd, credentials: { agentId, keyId, privateKey, runtime, ... } } }
  7. 等 ControlAck ≤5s
       │
       ▼
daemon control-channel dispatch → provision.ts:
  - writeCredentialsFile(..., { ...creds, runtime, cwd })
  - addAgentToConfig(cfg, ag_id)
  - gateway.addChannel(ag_id)
       │
       ▼
ControlAck { ok, result: { agentId } } → Hub → HTTP 200 → 前端
```

```
启动时 (toGatewayConfig):

  routes = cfg.routes.map(mapRoute)                // 用户显式
  for ag in agentIds:
    if agentRuntimes[ag]?.runtime:
      routes.push({                                // 注入 per-agent 终结性 route
        match: { accountId: ag },
        runtime: agentRuntimes[ag].runtime,
        cwd:     agentRuntimes[ag].cwd ?? defaultRoute.cwd,
      })

运行时路由 (收到一条 message):

router.resolveRoute(inboundMsg):
  for rule in cfg.routes:                          // 用户显式 → 注入的 per-agent
    if match(rule.match, inboundMsg): return rule
  return cfg.defaultRoute                          // 老配置兜底
```

### 5.2 职责分工

| 层 | 模块 | 职责 |
|----|------|------|
| Hub schema | `backend/migrations/0xx_agents_runtime.sql` | 给 `agents` 加 `runtime varchar(32)` 列 |
| Hub model | `backend/hub/models.py` | `Agent.runtime` |
| Hub BFF | `backend/app/routers/users.py`（新增 provision 端点） | 创建 agent 时校验并写入 runtime，调用控制 WS 下发 |
| Hub control push | `backend/hub/routers/daemon_control.py` | 构造含 runtime 的 `provision_agent` 帧 |
| 协议契约 | `packages/protocol-core/src/control-frame.ts` | 重命名 `adapter` → `runtime`；`credentials` 子对象加 `runtime` + `cwd` |
| daemon 凭据落盘 | `packages/protocol-core/src/credentials.ts` + `packages/daemon/src/provision.ts` | `StoredBotCordCredentials` 加 `runtime?` `cwd?`；provision 写入 |
| daemon 路由 | `packages/daemon/src/daemon-config-map.ts` + `packages/daemon/src/agent-discovery.ts` | 启动时把 `credentials.runtime` 编译成 per-agent route 追加进 gateway config；router.ts 保持不变 |
| 前端 | `frontend/src/components/daemon/` + store | 创建对话框 runtime 必选；列表展示 runtime 标签 |

## 6. 数据模型变更

### 6.1 Hub `agents` 表

```sql
alter table agents add column runtime varchar(32) null;

-- 可选：限制取值集合。保留 null 以兼容 bind_code 路径（没走 daemon provision）。
-- alter table agents add constraint ck_agents_runtime
--   check (runtime is null or runtime in ('claude-code', 'codex', 'gemini'));
```

**null 语义**：通过 bind_code 创建的 agent（非 daemon 场景）没有指定 runtime —— 保留 null，由接入方（OpenClaw / CLI）自决。

### 6.2 daemon 凭据文件

`~/.botcord/credentials/{ag_id}.json` 在现有字段基础上新增两项：

```json
{
  "version": 1,
  "agentId": "ag_xxx",
  "runtime": "claude-code",
  "cwd": "/Users/me/projects/blog",
  "hubUrl": "https://hub.botcord.dev",
  "keyId": "k_xxx",
  "privateKey": "...",
  "publicKey": "...",
  "savedAt": "2026-04-23T12:34:56.000Z",
  "displayName": "writer",
  "token": "...",
  "tokenExpiresAt": 1745712000000
}
```

**兼容**：`runtime` / `cwd` 为可选字段；老凭据文件读进来没有这两项就退化到 §4.3 第 3 步兜底。

### 6.3 `DaemonConfig` 保持不变

`agents: string[]` 继续是纯指针列表，不引入 `agentMeta`。per-agent 元数据全落在 credentials.json —— 它本来就是 per-agent 的天然宿主，避免 config.json 变成多权威。

## 7. 协议变更

### 7.1 `ProvisionAgentParams`（`packages/protocol-core/src/control-frame.ts`）

```ts
export interface ProvisionAgentParams {
  name?: string;
  bio?: string;
  cwd?: string;

  /** Agent runtime. Required for daemon provision path. */
  runtime?: string;

  /**
   * @deprecated alias for `runtime`. Retained one release for forward-compat
   * with any in-flight Hub builds that still emit the old name.
   */
  adapter?: string;

  credentials?: {
    agentId: string;
    keyId: string;
    privateKey: string;
    publicKey?: string;
    token?: string;
    tokenExpiresAt?: number;
    hubUrl?: string;
    displayName?: string;
    runtime?: string;  // 新增
    cwd?: string;      // 新增
  };
}
```

daemon 侧在 `provision.ts` 消费时优先读 `params.runtime`，miss 再读 `params.adapter`（兼容窗口一个 release 后删除）。

### 7.2 Hub BFF provision 端点

```
POST /api/users/me/agents/provision
Request:
  {
    "daemon_instance_id": "dm_xxx",
    "label": "writer",
    "runtime": "claude-code",
    "cwd": "~/projects/blog"
  }
Response 200:
  {
    "agent_id": "ag_xxx",
    "runtime": "claude-code",
    "display_name": "writer",
    "daemon_instance_id": "dm_xxx",
    "status": "online"
  }
Response 409:
  { "code": "daemon_offline" | "runtime_unavailable" }
```

`runtime_unavailable`：Hub 拒绝请求如果 `runtime` 不在该 daemon 最近上报的 `runtimes_json` 里 `available:true` 的集合内 —— 前端理论上不会让用户选到，这是服务端兜底。

### 7.3 `GET /api/users/me/agents` 返回扩展

```json
[
  {
    "id": "ag_xxx",
    "display_name": "writer",
    "runtime": "claude-code",
    "daemon_instance_id": "dm_xxx",
    "daemon_online": true,
    "created_at": "2026-04-23T12:34:56Z"
  }
]
```

## 8. 实现路径

### 8.1 P0：基础链路

1. Hub migration：`agents` 加 `runtime` 列。
2. Hub `Agent` model 加字段，schemas 加字段。
3. protocol-core：`ProvisionAgentParams.runtime` + `credentials.runtime/cwd`；保留 `adapter` 别名一个 release。
4. daemon `StoredBotCordCredentials` 加 `runtime` / `cwd`；`provision.ts::materializeCredentials` 写入；`writeCredentialsFile` / `loadStoredCredentials` 透传。
5. daemon router 增加 credentials.runtime 兜底逻辑。
6. Hub BFF `POST /api/users/me/agents/provision`：鉴权 → 校验 runtime available → INSERT → 下发控制帧 → 等 ack。

### 8.2 P1：前端接入

1. 创建对话框 runtime 必选，来源于所选 daemon 的 `runtimes[].available`。
2. agent 列表展示 runtime 标签（daemon 在线 / 离线都展示）。
3. `AgentBindDialog` 在用户名下有活跃 daemon 时默认切到 "在 daemon 上创建"，runtime 选择由 daemon 的 runtime_snapshot 驱动。

### 8.3 P2：老 agent 回填

给走 bind_code 创建的老 agent 一个回填途径：

- 前端 agent 详情页可选 "Set runtime"（一次性），写入 `agents.runtime`。
- 不下发到 daemon（bind_code 路径本来也不归 daemon 管）。

## 9. 风险与取舍

| 风险 | 缓解 |
|------|------|
| Hub `agents.runtime` 和 daemon credentials.runtime 漂移 | 只有 provision 时 Hub 写一次、下发一次；无后续同步。改 runtime 走 revoke + 重建。 |
| 老 credentials 文件没有 runtime 字段 | §4.3 第 3 步兜底 `defaultRoute.adapter`，行为与升级前一致。 |
| daemon 上报的 runtime_snapshot 过期 → 前端列了不存在的 runtime | Hub BFF 在 provision 时再校验一次；必要时触发 §8.5 `refresh-runtimes`。 |
| bind_code 路径 agent 没 runtime | `agents.runtime` 允许 null；前端展示 "—" 或 "Unknown"。 |
| 未来新增 runtime 需要 Hub 和 daemon 同步升级 | `agents.runtime` 不加 check constraint（§6.1 注释），runtime 字符串约定由 adapter registry 管理；Hub 只校验 "该 daemon 声称可用"。 |

## 10. 开放问题

- **cwd 存哪里权威**：目前方案里 `cwd` 和 runtime 一样落 Hub + daemon cache。但 cwd 是本地路径，和机器强绑 —— 是否应该**只**落 daemon？倾向：Hub 存一份用于前端展示（"这个 agent 指向 ~/projects/blog"），执行路径以 daemon credentials 为准。留观察。
- **runtime 取值集合的治理**：当前是字符串自由填；是否需要一张 `runtimes` 表由 Hub 管理全局可选集？短期不做，等 runtime 超过 5 个再说。
- **revoke 时是否清 `agents.runtime`**：revoke 流程里 agent 行通常软删（`revoked_at`）而非物理删除，runtime 字段保留便于事后审计。

## 11. 与现有文档的关系

- 补 `daemon-control-plane-plan.md` §8.4 里 "runtime 塞进 params" 的落地细节，§8.5 `runtime_snapshot` 的消费者之一就是本方案的 provision 校验。
- 不冲突 `daemon-agent-discovery-p1.md`：发现机制读 credentials 文件，本方案只是给文件加了两个字段，结构向后兼容。
- 不冲突 `gateway-module-plan.md`：gateway 仍然只看 route 决策，router 内部多了一条 credentials 兜底规则，不改 channel 抽象。
