<!--
- [INPUT]: 依赖 cloud-gateway-ingress-technical-design.md 的 always-on observer + thin Hub lifecycle 架构，依赖 packages/gateway-ingress/src/providers/telegram.ts 的 ProviderAdapter 实现样板，参考 ~/cc-connect/platform/discord/discord.go 的成熟 discordgo Gateway 接入模式。
- [OUTPUT]: 输出 Cloud Agent Discord 第三方接入方案，包括 provider adapter 形态、Gateway/Intent 选择、mention/thread/slash 语义、Hub 侧 schema 与配置 UX、运维与灰度计划。
- [POS]: cloud-gateway-ingress-technical-design.md 的 Discord 章节展开；总架构以主文档为准，本文只补 Discord 特定差异。
- [PROTOCOL]: 影响 RuntimeGatewayProvider 枚举、gateway-ingress provider 注册、Discord 侧消息可见性策略或 thread 路由的变更，先更新本文，再改实现。
-->

# Cloud Gateway Ingress: Discord 接入设计

> 状态: 方案草案，待评审
> 日期: 2026-05-25
> 范围: 在 `gateway-ingress` 中新增 `discord` provider；Hub 侧 thin lifecycle / dashboard config 扩展；不改动 cloud daemon 与 Hub 的边界

## 1. 背景

`gateway-ingress` 已落地 Telegram getUpdates polling adapter（`packages/gateway-ingress/src/providers/telegram.ts`），架构上把 _always-on observer_ 和 _runtime executor_ 拆开（主文档 §1）。Discord 是用户量级最大、最稳定的第三方 IM，且 **Discord Gateway 是出站 WS**，不需要公网入口或 webhook，正好契合 ingress "本机或单点常驻 + 出站连接 + 拉取式拉起 cloud sandbox" 的形态。

参考实现是 [`cc-connect/platform/discord/discord.go`](https://github.com/chenhg5/cc-connect/blob/main/platform/discord/discord.go)（约 1400 行 Go，基于 [`bwmarrin/discordgo`](https://github.com/bwmarrin/discordgo)）。它已经覆盖：连接保活、Intents、guild mention-only、Bot Role mention、@everyone/@here、thread_isolation、slash command、ApplicationCommand 注册与 follow-up、attachment 分类（image / file / audio）、reply preview、typing、消息切片（2000 char）。本文复用其工程经验，不重新走一遍这套设计的踩坑过程。

Discord 接入做完后，`RuntimeGatewayProvider` 从 `"telegram" | "wechat" | "feishu"` 变成 `… | "discord"`，Cloud Agent 可以以 Discord Bot 身份在用户的 Discord 服务器里被 @ 并对话。

## 2. 设计目标与非目标

### 目标

- Cloud Agent 可以绑定一个 Discord Bot Token，gateway-ingress 维持该 Bot 的 Gateway WS。
- Discord guild 消息：默认 mention-only；可选 group_reply_all（白名单 guild）。
- Discord DM：mention 与否都接收。
- 可选 `thread_isolation`：每个 fresh session 在 parent channel 下开一个 thread，会话隔离 + 复用同一 channel 的工作目录绑定。
- 出站消息：自动按 2000 char 切片；MVP 不支持 edit-message 流式（与 telegram 一致先做 final-only / chunk）。
- attachment：image / file / audio 分类后随入站 frame 透出给 cloud daemon（图片占用同样的 `images` 字段，运行时按 provider 透明处理）。
- Hub 与第三方消息正文继续完全解耦（沿用主文档 §4.2 约束）。

### 非目标（MVP 不做）

- slash command 注册与 Application Command Interaction 的全功能支持（先用普通 message 路径；slash 命令进入第二阶段）。
- voice / video / sticker / poll / forum channel。
- Discord 端原生流式 edit-message（先 final-only；下一阶段引入 `gateway_outbound_delta` → `ChannelMessageEdit`）。
- 把 Discord 对话写入 BotCord room/history（主文档明确不做）。
- 让本地 daemon 通过 ingress 走 Discord（本地 daemon 沿用现状，自己启 discordgo 连接）。
- 全局 ApplicationCommand 注册（实例数 × ratelimit 不可控，仅在 phase 2 用 guild_id-scoped 注册做 per-deployment 试点）。

## 3. 总体形态

```text
Discord                           gateway-ingress                       Cloud daemon
─────────                         ───────────────                       ────────────
guild / DM ── Gateway WS ─►  DiscordProviderAdapter
                              │  - discord.js v14 / @discordjs/ws
                              │  - dedupe(message_id, interaction_id)
                              │  - mention / role / @everyone 判定
                              │  - thread_isolation 路由
                              │  - attachment 分类下载
                              ▼
                       NormalizedInboundMessage
                              │
                              ▼
                       Orchestrator (现有)
                              │
                              ▼
                       Hub ensure-running (现有 thin API)
                              │
                              ▼
                       Runtime WS frame: gateway_inbound  ───────────►  agent turn
                                                                            │
                       provider sender ◄────  gateway_outbound_complete ◄───┘
                              │
                              ▼
                  Discord REST: createMessage / editMessage / startThread / sendFile
```

Hub 不在 data path 上，只暴露已有的 `POST /internal/cloud-gateway/agents/{agent_id}/ensure-running` 等接口（runtime-frame.ts §Hub thin lifecycle）。

## 4. 类型与契约扩展

### 4.1 `RuntimeGatewayProvider`

`packages/protocol-core/src/runtime-frame.ts`：

```diff
- export type RuntimeGatewayProvider = "telegram" | "wechat" | "feishu";
+ export type RuntimeGatewayProvider = "telegram" | "wechat" | "feishu" | "discord";
```

Cloud daemon、Hub model 一次性更新枚举校验（保持现有的 union 验证模式）。

### 4.2 NormalizedInboundMessage 的 Discord 字段约定

不改 schema，仅约定取值：

| 字段 | Discord 取值 |
|---|---|
| `id` | `discord:{channelId}:{messageId}`（与 cc-connect 的 dedupe key 命名风格保持一致）|
| `channel` | gateway connection id（如 `gw_dc_xxx`），与其他 provider 一致|
| `accountId` | `ag_…`|
| `conversation.id` | DM: `discord:dm:{channelId}`；guild 普通频道: `discord:channel:{channelId}`；thread: `discord:thread:{threadId}`|
| `conversation.kind` | DM → `direct`；guild channel / thread → `group`|
| `conversation.title` | `channel.name`（thread 用 thread name；用于 ChatName 展示）|
| `conversation.threadId` | thread 模式下填 thread.id；否则 null|
| `sender.id` | `discord:user:{userId}`|
| `sender.name` | `username` 或 `globalName`|
| `text` | 已剥离 `<@botId>` / `<@!botId>` / `<@&botRoleId>` 与可选的 `@everyone` / `@here` 后的纯文本|
| `mentioned` | guild 模式：bot 被 @user / @role / @everyone 中任一即 true；DM 默认 true|
| `replyTo` | 若为 reply，填被引用 message 的 id；referenced 内容会拼到 `text` 前缀（"[replying to {author}: …]"）以保留语境，与 cc-connect 一致|

> 设计点：`conversation.id` 用三种前缀显式区分 DM / channel / thread，让运行时无需再访问 Discord API 即可判断。

### 4.3 Outbound 路由约定

`OutboundSendRequest.conversationId` 在 ingress 内部直接解析回 `(channelId, threadId?)`，再选择：

| 场景 | Discord REST |
|---|---|
| DM / 普通 channel | `POST /channels/{channelId}/messages`|
| thread | `POST /channels/{threadId}/messages`|
| 回复指定消息（保留 ReplyContext.messageId） | `messages` + `message_reference` |
| 切片 | 单条 > 1900 char 时本地切（与 cc-connect 同步缩到 1900，给富文本 markdown 余量）|

## 5. Provider Adapter 实现

文件：`packages/gateway-ingress/src/providers/discord.ts`，签名遵循 `ProviderAdapter`：

```ts
export interface DiscordProviderOptions {
  gatewayId: string;
  /** 测试钩子，注入 mock client */
  clientFactory?: (token: string) => DiscordGatewayClient;
}

export function createDiscordProvider(opts: DiscordProviderOptions): ProviderAdapter
```

### 5.1 依赖选择

| 选项 | 评价 |
|---|---|
| **`discord.js` v14**（推荐）| TS 原生、维护活跃、社区最大、覆盖 Gateway + REST + interaction；体积偏大但 ingress 是单进程服务可接受。|
| `@discordjs/ws` + `@discordjs/rest`| 更轻量，自己拼 shard / interaction。可作为 phase 2 的优化项。|
| 自写 WS（gorilla 风格）| 复刻 cc-connect 的成本远大于收益；不建议。|

MVP 选 **discord.js**。锁定到 next-supported LTS，不开自动 ETF / zlib（Node 22 性能 OK）。

### 5.2 ProviderRuntimeContext 用法

```ts
async function loop(ctx: ProviderRuntimeContext) {
  const secret = ctx.secret as { botToken: string };
  const config = ctx.connection.config as DiscordConnectionConfig;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,   // privileged: 必须在开发者后台开启
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],          // 接收 DM 需要
  });

  client.on(Events.MessageCreate, async (m) => onMessage(m, ctx, config));
  client.on(Events.ClientReady, (c) => {
    botId = c.user.id;
    appId = c.application.id;
    ctx.markActivity({ lastPollAt: Date.now() });
  });
  client.on(Events.Error, (err) => ctx.markActivity({ lastError: String(err) }));
  client.on(Events.ShardDisconnect, …);

  ctx.abortSignal.addEventListener("abort", () => client.destroy(), { once: true });
  await client.login(secret.botToken);
}
```

cursor 不需要（Gateway 是 push）。`persistCursor` 留空；`loadCursor` 返回 `{}`。

### 5.3 入站消息处理（核心）

照搬 cc-connect 的判定顺序，保证语义一致：

```text
1. dedupe(m.id) via in-memory LRU(window=2min)        // 与 telegram 不同，message id 全局唯一即可
2. m.author.bot 或 m.author.id == botId → 丢弃
3. core.IsOldMessage 等价：m.createdTimestamp < startupTs - 60s → 丢弃（避免重启回放）
4. allowFrom allowlist 判定 m.author.id              // 与 ingress 现有 allowedSenderIds 对齐
5. 若是 guild 且非 group_reply_all guild：
     - 计算 botRoleId（每个 guild 缓存一次，从 GuildMember.roles 找 managed=true）
     - isDiscordBotMention(m, botId, botRoleId, respondToAtEveryoneAndHere) → false 则丢弃
     - 剥离 `<@botId>` `<@!botId>` `<@&botRoleId>` 与可选 `@everyone`/`@here`
6. 计算 sessionKey / conversationId / replyContext
7. attachment 分类 + 下载（最大 50MB / 每附件）
8. referenced message 内容前缀化拼到 text，referenced attachment 中的图片同步前置
9. emit(normalized, providerEventId="dc:{guildOrDm}:{messageId}")
```

### 5.4 Thread Isolation

`config.threadIsolation === true` 且消息来自 guild text/news channel 时：

```text
if 消息已经在 thread 内：
    parentChannelId = channel.parentId
    conversation.id = `discord:thread:${channel.id}`
elif 消息所在 message 已 attach 了 thread：
    join 那个 thread；后续从 thread 内继续路由
else：
    startThread(channelId, messageId, name=truncate(text, 90), archiveDuration=1440)
    join 新 thread
```

设计要点（继承自 cc-connect）：
- `conversation.title` 用 **thread name**，但工作目录绑定线索仍走 **parent channel id**（mirror cc-connect 的 `channelKey` 机制）。这一点要把 parent channel id 顺路传给 cloud daemon——但目前 NormalizedInboundMessage 没有 `parentChannel` 字段。
- 处理方式：在 `conversation.id` 里用 `discord:thread:{threadId}`，并新增可选字段 `conversation.parentId?: string`（仅 Discord 用，其他 provider 留空）。这是对 schema 的最小扩展。

### 5.5 Slash Command（Phase 2，不在 MVP）

- 仅在 `config.guildId` 配置时调用 `ApplicationCommandBulkOverwrite(appId, guildId, cmds)`，避免 global 1h propagation 和 ratelimit 风险。
- Interaction 入站：先 `InteractionRespond(Deferred)`，再走与 messageCreate 相同的 normalized 路径；出站第一条用 `InteractionResponseEdit`，后续用 `FollowupMessageCreate`。
- 注册 source-of-truth：Hub 不感知；ingress 启动时拉 BotCord 的 `command_registry`（已有概念）做一次 bulk overwrite。

### 5.6 出站消息

```ts
async function send(req: OutboundSendRequest): Promise<OutboundSendResult> {
  const target = parseConversationId(req.conversationId);   // {channelId, isThread}
  const channel = await client.channels.fetch(target.channelId);
  const chunks = splitText(req.text, 1900);                  // ascii-aware + code-fence-aware
  let lastId: string | null = null;
  for (const chunk of chunks) {
    const sent = await channel.send({ content: chunk });
    lastId = `discord:${channel.id}:${sent.id}`;
  }
  return { providerMessageId: lastId };
}
```

streaming（phase 2）：第一次 `delta` 创建 message → 后续 `delta` `messages.edit` 同一条直到 `complete`；超过 5 次/秒 edit 时退化为追加。

### 5.7 错误与重连

- discord.js 内部已带自动重连；ingress 只需在 `Events.ShardError` / `ShardDisconnect(1000)` 时记 `lastError` 即可。
- token 失效（4004）→ markActivity({ lastError: "invalid_token" }) → stop adapter；上层 orchestrator 把 connection.status 置为 `error`，等待用户重新绑定。
- Privileged Intent 未开启（4014）→ 与 token 失效同处理路径，但 `lastError = "message_content_intent_required"` 给 dashboard 明确指引。

## 6. 注册到 Registry

`packages/gateway-ingress/src/providers/registry.ts`：

```ts
import { telegramProviderFactory } from "./telegram.js";
import { discordProviderFactory } from "./discord.js";

export const DEFAULT_PROVIDER_FACTORIES: Record<string, ProviderAdapterFactory> = {
  telegram: telegramProviderFactory,
  discord: discordProviderFactory,
};
```

`discordProviderFactory: ProviderAdapterFactory = (gatewayId) => createDiscordProvider({ gatewayId })`。

## 7. Hub 侧增量

Hub 在第三方消息链路中保持 thin，但 dashboard 配置仍由 Hub 持久化。

### 7.1 Schema

`gateway_connections.provider` 加入 `discord` 取值。`config_json` 形如：

```jsonc
{
  "appId":        "1234567890",          // 可选，仅 phase 2 注册 slash 时用
  "guildId":      "9876543210",          // 可选，仅注册 guild-scoped slash
  "groupReplyAll": false,
  "groupReplyAllGuilds": ["123…"],       // 任一为 "*" 即全 guild 都开
  "shareSessionInChannel": false,
  "threadIsolation": true,
  "respondToAtEveryoneAndHere": false,
  "allowedSenderIds": ["…"],
  "allowedChatIds":   ["…"]
}
```

`secret_ref` 指向 ingress secret store 中的 `{ botToken: "MTk4…" }`。Hub 不存 token 明文，token 只下发到 ingress secret store；dashboard 录入时直传 ingress、Hub 只持有 `secret_ref` 句柄（与 telegram 现有路径一致）。

### 7.2 Dashboard 接入向导（用户视角）

参考 [cc-connect/docs/discord.md](https://github.com/chenhg5/cc-connect/blob/main/docs/discord.md) 的 9 步流程，但 BotCord 这边把 ingress 部分变透明：

1. Discord Developer Portal 新建 Application + Bot
2. **必须**开启 `Message Content Intent`（顶级 FAQ）
3. 复制 Bot Token
4. OAuth2 URL Generator：scope=`bot`（+ phase 2 加 `applications.commands`）；Permissions 勾：View Channels / Send Messages / Create Public Threads / Send Messages in Threads / Read Message History
5. 用 URL 邀请 Bot 到 Server
6. 回到 BotCord Dashboard → 选 Cloud Agent → Bind Discord → 粘 Token、勾 thread_isolation 等开关、Save
7. Save 后由 Hub 写 `gateway_connections` + 把 token 透传给 ingress secret store；ingress orchestrator 触发新 adapter 上线
8. 在 Discord 任意频道 @bot 验证

## 8. 失败语义补充

主文档 §12 的策略对 Discord 直接适用，下面只列差异：

| 场景 | 处理 |
|---|---|
| Privileged Intent 未开 | adapter ready 后 messageCreate 永远收不到，需要主动探测。**做法**：连上 5 分钟内若 `lastInboundAt` 一直为空且接收到的 messageCreate `content === ""` 比例 > 90%，标记 `lastError="message_content_intent_required"` 并提示 dashboard。|
| Bot 被踢出 server | guild 消失事件后，cache 中该 guild 的 botRoleId 清掉；不影响其他 guild。|
| Discord 全局 ratelimit | discord.js 内置 bucket；ingress 不需要额外处理。手动限流出现 `RateLimitedError` 时本地排队（短时 < 5s）或推后到下一次 send。|
| message ID 重复 | Gateway 偶发重复 dispatch（与 cc-connect 注释一致）→ 2 分钟 LRU 直接丢弃。|
| Bot Token rotate | dashboard 触发 secret 更新 → orchestrator 收到 connection update → stop old client → start new client；事件流不丢失（events 已经在 durable queue）。|

## 9. 安全与隐私

- Bot Token 只存在于 ingress secret store；Hub 与 cloud daemon 都拿不到原 token。
- 出站 frame 中不携带 Discord token、user email、avatar URL 之外的 PII；runtime 看到的 sender 仅 username + numeric id。
- attachment 下载存放在 ingress 临时目录，最长保留至 outbound complete + 1h；不持久化原始 binary 到 Hub。
- 日志：必须 redact token（discord.js 默认会，二次校验 logger 字段白名单）。
- guild 消息默认 mention-only；`groupReplyAllGuilds` 必须显式开启，dashboard 上做二次确认。

## 10. 实施阶段

| Phase | 内容 | 退出条件 |
|---|---|---|
| **0** | `RuntimeGatewayProvider` 枚举扩展 + `NormalizedInboundMessage.conversation.parentId?` 可选字段 + 全链路类型编译通过 | `pnpm build` 全绿；现有 telegram e2e 不回归 |
| **1** | `discord.ts` provider adapter（DM + guild mention-only + 切片出站 + dedupe + 重连） | 一个测试 Bot 在测试 server 完整跑通：@bot → cloud daemon turn → final text 回复 |
| **2** | thread_isolation + reply context + attachment 入站 | 同一会话连续多轮 thread 内运行；图片上传后 agent 能看到 |
| **3** | Slash command（仅 guild-scoped）+ ratelimit dashboard 指标 | `/help` 等命令可触发 turn |
| **4** | Streaming（edit-message）+ progress card 等价物 | 一次 turn 中只编辑同一条消息直到 complete |

Phase 1 即可独立合并、灰度放给少数内测 agent。每个 phase 一个 PR，commit prefix `feat(gateway-ingress): discord …`。

## 11. 测试策略

- **单元**：discord.ts 通过注入 `clientFactory` mock 出 Gateway client，覆盖 dedupe / mention 判定 / thread 路由 / 切片。仿 telegram.ts 的 fetchImpl 注入模式。
- **集成**：`packages/gateway-ingress/src/__tests__/discord.integration.test.ts` 用 `nock` 拦截 Discord REST，WS 端用本地 fake gateway server。
- **手测**：脚本 `scripts/discord-smoke.ts`，读取本地 `.env` 中的 testing token + guild + channel id，发一条 `@bot ping`，断言返回中包含 `pong`。
- **不引入** Discord 官方账号到 CI；token 只在 ingress 维护者本地 + staging 部署中存在。

## 12. 开放问题

- `NormalizedInboundMessage.conversation.parentId` 的命名是否要更通用（`conversation.parentChannelId`）以便 Feishu / Slack 后续复用？建议在 phase 0 决定后冻结。
- discord.js 是否需要在 ingress Dockerfile 中固定到具体 minor 版本？社区每 ~3 个月推一次 API 变动，建议锁 minor、CI 定期升级。
- Slash command 注册的 source-of-truth：由 ingress 启动时从 Hub 拉，还是由 dashboard 显式 `Register Commands` 按钮触发？建议后者，避免每次 ingress 重启都 bulk overwrite。
- streaming edit-message 的速率：Discord 单频道 5 edits/5s，对 token-stream 太紧；phase 4 需要内置一个 `coalesce(delta, minIntervalMs=1000)` 的 buffer。

## 13. 与 cc-connect 实现的差异速查

| 维度 | cc-connect (Go, single-process) | botcord ingress (TS, multi-tenant) |
|---|---|---|
| 进程模型 | 一个 cc-connect 对一个 bot token | 一个 ingress 进程承载多个 agent 的多个 bot adapter |
| 入站去重 | sync.Map + 2 min TTL | 同语义；用 LRUMap 或 in-memory Map + setTimeout |
| 会话 key | `discord:{channelId}[:{userId}]` 字符串 | 用 NormalizedInboundMessage.conversation.id；runtime 自己派生 session |
| 工作目录绑定 | `<base_dir>/<parent-channel-name>` | 不存在；runtime 不绑工作目录 |
| 出站切片 | 1900 chars + code-fence aware | 同 |
| Slash 注册 | 每次 ready 时 bulk overwrite | dashboard 显式触发，避免大规模 bot 时雷暴 |
| Progress 卡片 | 三种 style (`legacy`/`compact`/`card`) | MVP 不引入；statement 仍是 final-only |
| 代理 | 支持 HTTP proxy | ingress 部署侧解决（k8s egress 或 HTTP_PROXY 环境变量），不进 adapter 配置 |

## 14. 一句话总结

把 cc-connect 那一套验证过的 discordgo 玩法翻译成 TS 上的 `ProviderAdapter`，复用 `gateway-ingress` 现有的 always-on + durable + ensure-running 链路；Hub 不在 data path 上，新增的只是 `provider="discord"` 这一个枚举值和一份配置 JSON。
