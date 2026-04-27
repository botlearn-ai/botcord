# Daemon 内嵌 CLI 分发策略

## 背景

当用户通过以下命令启动 daemon：

```bash
npx -y -p @botcord/daemon@latest botcord-daemon start --hub https://api.preview.botcord.chat
```

daemon 会为每个 agent 在 `~/.botcord/agents/{agentId}/` 下拉起 runtime（Claude Code / Codex / Gemini）。这些 runtime 经常需要在自己的 workspace 里调用 `botcord` CLI 完成发消息、查房间、管理联系人等操作。

当前问题：

- `@botcord/daemon` 的 `dependencies`（`packages/daemon/package.json:30`）没有 `@botcord/cli`——`npx -p @botcord/daemon` 不会附带 CLI。
- 即使用户全局 `npm i -g @botcord/cli`，runtime 子进程虽然能通过继承的 `PATH` 找到 `botcord`，但会出现：
  - **版本漂移**：daemon 与 CLI 各自 `latest`，`@botcord/protocol-core` 可能不一致（daemon 当前 `^0.2.0`，CLI 当前 `^0.1.0`，npm 会同时装两份），签名/控制帧不兼容。
  - **Hub 错配**：CLI 默认 hub 不一定与 daemon 启动时 `--hub` 对齐。
  - **agent 误用**：所有 agent 共用 `~/.botcord/credentials/`，runtime 调 CLI 时若不显式传 `--agent` 会落到 `~/.botcord/default.json`。

## 目标

让 runtime 在自己的 workspace 中调用 `botcord` CLI 时：

1. 拿到与 daemon **版本绑定**的 CLI；
2. **自动**使用该 agent 对应的 hub URL；
3. **自动**作用于 workspace 所属的 agent，避免误操作他人凭证；
4. 用户**零额外安装步骤**——`npx -p @botcord/daemon@latest` 一条命令就够。

## 方案：依赖内嵌 + bin 解析 + Env 注入

四步缺一不可。

### 1. 先对齐 protocol-core 版本，再把 CLI 加进 daemon 依赖

**前置**：把 `cli/package.json` 里 `"@botcord/protocol-core": "^0.1.0"` 升到 `^0.2.0`，与 daemon 对齐，避免 npm 同时安装两份不兼容版本。后续在 release 流程里加一道校验：daemon 与 CLI 的 protocol-core 范围必须一致。

然后 `packages/daemon/package.json`：

```json
{
  "dependencies": {
    "@botcord/cli": "^0.1.7",
    "@botcord/protocol-core": "^0.2.0",
    "ws": "^8.18.0"
  }
}
```

> 包名是 `@botcord/cli`（CLI 的 `bin` 才叫 `botcord`），不是 `botcord`——npm 上没有 `botcord` 包。
>
> 版本下限**必须指向 protocol-core 已升级到 `^0.2.0` 的那个新版**。当前 npm 上的 `@botcord/cli@0.1.6` 仍依赖 `protocol-core@^0.1.0`（`cli/package.json:32`），且已发布的版本不可变。所以落地顺序是：先发 CLI 新版本（例如 `0.1.7` 或 `0.2.0`，把 protocol-core 升到 `^0.2.0`），然后 daemon 才能依赖那个新版。文档里的 `^0.1.7` 是占位，发版时按实际新版号填。

效果：

- `npx -y -p @botcord/daemon@latest` 拉取 daemon 时，npm 会把 `@botcord/cli` 与其依赖一并放到临时安装根；
- 两边共享同一份 `@botcord/protocol-core`，签名算法、会话密钥派生、控制帧 schema 一致。

### 2. 用 `createRequire` 解析 CLI bin 的真实路径

不能假设 `daemonPackageDir/node_modules/.bin/botcord` 存在。npm 通常会把依赖**提升**到顶层（`<install-root>/node_modules/@botcord/cli`），bin 落在 `<install-root>/node_modules/.bin/botcord`，而非 daemon 子目录下。最稳妥的做法是用 `createRequire` 解析包路径，再读 `bin` 字段。

在 daemon 里加一个辅助：

```ts
// packages/daemon/src/gateway/cli-resolver.ts
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);

let cached: { binDir: string; binPath: string } | null = null;

export function resolveBundledCliBin(): { binDir: string; binPath: string } | null {
  if (cached) return cached;
  try {
    const pkgJsonPath = require.resolve("@botcord/cli/package.json");
    const pkgRoot = path.dirname(pkgJsonPath);
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.botcord;
    if (!binRel) return null;
    const binPath = path.resolve(pkgRoot, binRel);
    // PATH 注入要指向 install root 的 node_modules/.bin（npm 在那里建 botcord
    // 软链），而不是 CLI 包内部的 dist/。pkgRoot 形如
    //   <install-root>/node_modules/@botcord/cli
    // 上溯两级到 <install-root>/node_modules，再 + .bin。
    const binDir = path.resolve(pkgRoot, "..", "..", ".bin");
    cached = { binDir, binPath };
    return cached;
  } catch {
    return null; // CLI 未安装时优雅降级
  }
}
```

注意：

- `binPath` 用于 daemon 自己**直接 spawn** CLI 入口（不依赖 `.bin` 软链是否存在，最可靠）；
- `binDir` 用于注入 PATH，覆盖"runtime 在 shell 里手敲 `botcord`"的场景；
- 不能用 `path.dirname(binPath)`——那会指向 `@botcord/cli/dist/`，PATH 里没有名为 `botcord` 的可执行文件。

### 3. 把 per-agent hubUrl 透传到 runtime，再注入 PATH 和环境变量

当前 `RuntimeRunOptions`（`packages/daemon/src/gateway/types.ts:260`）和 dispatcher 的 `runtime.run(...)` 调用（`packages/daemon/src/gateway/dispatcher.ts:572`）只带 `accountId`，没有 `hubUrl`。

正确的 per-agent hub 来源是**凭证文件本身**：每张 agent 凭证记录了它注册时所连的 hub，由 `agent-discovery.ts` 在 boot 时读出。`DiscoveredAgentCredential.hubUrl`（`packages/daemon/src/agent-discovery.ts:28`、`:162`）是权威来源——**不是** daemon 用户控制面登录用的 `record.hubUrl`（`packages/daemon/src/index.ts:294`，那个是登录 hub，与 agent 凭证 hub 可以不同）。

需要补：

1. `RuntimeRunOptions` 增加 `hubUrl: string`；
2. `startDaemon` 从 `boot.agents` 构建 `hubUrlByAgentId: Map<string, string>`，注入到 dispatcher / route 上下文；
3. dispatcher 在 `runtime.run(...)` 调用处按 `msg.accountId` 查表，把 `hubUrl` 一起传下去；找不到时按 daemon 启动的 `--hub` 兜底（也只是兜底，正常路径不会用到）；
4. `NdjsonStreamAdapter.spawnEnv`（`packages/daemon/src/gateway/runtimes/ndjson-stream.ts:77`）改成：

```ts
protected spawnEnv(opts: RuntimeRunOptions): NodeJS.ProcessEnv {
  const cli = resolveBundledCliBin();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BOTCORD_HUB: opts.hubUrl,
    BOTCORD_AGENT_ID: opts.accountId,
  };
  if (cli) {
    env.PATH = `${cli.binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  }
  return env;
}
```

`cli` 解析失败时只做 env 注入（让用户的全局 CLI 仍可用），不阻塞 runtime 启动。

### 4. CLI 端补齐 env fallback

`cli/src/index.ts:71` 当前只读 `--agent`，需要加 `BOTCORD_AGENT_ID` fallback：

```ts
const globalAgent =
  (typeof args.flags["agent"] === "string" ? args.flags["agent"] : undefined)
  ?? process.env.BOTCORD_AGENT_ID
  ?? undefined;
```

`BOTCORD_HUB` 已在 `cli/src/index.ts:74` 读过，保持不变。同时把 HELP 文本里的 Environment 段补上 `BOTCORD_AGENT_ID`。

runtime 在 workspace 里直接：

```bash
botcord room list           # 自动用对的 hub + 对的 agent
botcord send --to rm_xxx --text "hi"
```

完全不需要手动传参。

## 方案对比

| 维度 | 全局安装 (`npm i -g @botcord/cli`) | 每次 `npx -y @botcord/cli` | **依赖内嵌（本方案）** |
|------|-------------------------------------|------------------------------|------------------------|
| 版本与 daemon 对齐 | 漂移 | 各自 latest | 锁定 |
| 调用延迟 | 低 | 每次拉包 | 仅 daemon 启动一次 |
| 用户安装步骤 | 多一步 | 无 | 无 |
| Hub 环境一致 | 手动 `--hub` | 手动 `--hub` | 自动（per-agent） |
| agent 误用风险 | 高 | 高 | env 兜底 |

## 边界与非目标

- **凭证目录仍共享** `~/.botcord/credentials/`。设计如此（一台机器多 agent 共存）；`BOTCORD_AGENT_ID` 用于"默认作用域"，**不是安全隔离层**。如未来需要强隔离，再引入 per-agent HOME。
- **用户在自己终端**手敲 `botcord ...` 仍走全局安装路径，与 daemon 无关。两条调用链并存。
- 不改变 plugin / OpenClaw 路径下 `botcord_*` agent tool 的行为——那是另一条独立的工具注入链路。

## 落地步骤

1. **对齐 protocol-core 并发版 CLI**：把 `cli/package.json` 的 `@botcord/protocol-core` 升到 `^0.2.0`，跑 CLI 单测确认无回归，**发布新版本**（如 `0.1.7` 或 `0.2.0`）到 npm；旧 `0.1.6` 不可变，必须以新版为准；
2. **加 daemon 依赖**：`packages/daemon/package.json` 加 `"@botcord/cli": "^<新版本>"`（指向第 1 步发布的版本）；
3. **新增 `cli-resolver.ts`**：用 `createRequire` 解析 CLI 包根，`binDir = <install-root>/node_modules/.bin`，`binPath = pkgRoot + bin.botcord`；
4. **plumb per-agent hubUrl**：扩展 `RuntimeRunOptions` 加 `hubUrl: string`；`startDaemon` 从 `boot.agents`（`agent-discovery.ts:28,162`）构建 `hubUrlByAgentId`，dispatcher 在 `runtime.run(...)`（`dispatcher.ts:572`）按 `msg.accountId` 查表填入；
5. **改 `spawnEnv`**：在 `ndjson-stream.ts:77` 注入 PATH + `BOTCORD_HUB` + `BOTCORD_AGENT_ID`；
6. **改 CLI**：`cli/src/index.ts:71` 加 `BOTCORD_AGENT_ID` fallback，HELP 同步更新；
7. **release 流程校验**：CI 检查 daemon/cli 的 `@botcord/protocol-core` 范围一致；
8. **e2e 验证**：
   - `npx -y -p @botcord/daemon@latest botcord-daemon start --hub <preview>` 起 daemon；
   - 让 runtime shell 执行 `botcord room list`，确认请求打到 preview hub，且作用于 workspace 对应的 agent；
   - 切换 agent workspace 重复一遍，验证身份与 hub 都按 per-agent 解析；
   - 卸载/未安装 `@botcord/cli` 的退化路径：daemon 仍能起，runtime fallback 到全局 `botcord`（若有）或报"command not found"。

## 风险

- **daemon 包体积**变大（多一份 CLI 及其依赖）。CLI 体量小，可接受。
- **CLI 升级耦合 daemon 发版**。利大于弊：通过统一发版避免协议层面的版本漂移。如需独立修 CLI bug，照常发 patch 版本，daemon 下次发版自动跟进。
- **`createRequire` 解析依赖 npm 实际拓扑**。已在第 2 步用 try/catch 优雅降级；CI 里需要至少一个 e2e 真跑 `npx -p @botcord/daemon`，确保解析路径在真实安装结构下成立。
