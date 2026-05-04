# Third-Party Gateway Design: WeChat and Telegram

## 背景

当前 BotCord daemon 已经有一套通用的 gateway core：

- `ChannelAdapter` 负责接入消息平台，输出标准 `GatewayInboundMessage`，并实现 `send()` 回写消息。
- `ChannelManager` 负责 channel 生命周期、状态、崩溃重启和 hot-plug。
- `Dispatcher` 负责路由、session、runtime 调用、stream block、typing、attention gate。
- `toGatewayConfig()` 当前为每个 BotCord agent 固定生成一个 `botcord` channel。

因此微信、Telegram 的接入不应该作为新的 runtime 实现，而应该作为新的 **channel adapter** 实现。Agent 的 runtime 仍然是 `claude-code`、`codex`、`gemini`、`openclaw-acp`、`hermes-agent` 等；微信/Telegram 只是新的消息入口。

命名上建议避免继续扩大 `gateway` 的歧义：

- daemon 内部沿用 `ChannelAdapter` / `GatewayChannelConfig`。
- 产品和 API 层使用 `third-party gateway` 或 `external channel`。
- `openclaw-acp` 的 `gateway` 继续特指 OpenClaw runtime endpoint。

## 参考实现

`~/glance/remote` 里已有可参考的轻量 bridge：

- `remote/bridges/telegram.py`：Telegram polling，无公网 webhook。
- `remote/bridges/wechat.py`：微信 iLink Bot API 长轮询。
- `remote/bridges/wechat_login.py`：二维码登录获取 `bot_token`。

微信实现的关键协议点：

- 默认 base URL：`https://ilinkai.weixin.qq.com`
- 登录：
  - `GET /ilink/bot/get_bot_qrcode?bot_type=3`
  - `GET /ilink/bot/get_qrcode_status?qrcode=...`
  - 用户扫码确认后返回 `bot_token`
- 收消息：
  - `POST /ilink/bot/getupdates`
  - 请求体携带 `get_updates_buf` 游标
  - 服务端长轮询，代码注释里说明服务端最长 hold 约 35 秒
- 发消息：
  - `POST /ilink/bot/sendmessage`
  - 入站消息带 `from_user_id` 和 `context_token`
  - 回复必须带回 `context_token`
- typing：
  - `POST /ilink/bot/getconfig` 获取 `typing_ticket`
  - `POST /ilink/bot/sendtyping` 发送 typing 状态
- 每次请求都需要：
  - `AuthorizationType: ilink_bot_token`
  - `Authorization: Bearer <bot_token>`
  - `X-WECHAT-UIN: base64(random uint32)`
  - body 中包含 `base_info: { channel_version: "1.0.2" }`

这意味着微信 MVP 可以走 daemon 本地 polling，不需要公网回调或 Hub relay。

## 目标

一个 BotCord agent 可以绑定多个第三方消息入口：

- BotCord 内置入口：现有 `botcord` channel，默认存在。
- Telegram bot：用户在 agent 设置中填入 bot token、白名单、启用状态。
- WeChat iLink bot：用户在 agent 设置中扫码登录，daemon 保存 bot token，用户配置白名单。

第三方消息进入后，统一被转换为 `GatewayInboundMessage`：

```ts
{
  channel: "gw_xxx",
  accountId: "ag_xxx",
  conversation: {
    id: "wechat:user:xxx@im.wechat",
    kind: "direct"
  },
  sender: {
    id: "xxx@im.wechat",
    kind: "user"
  },
  text: "...",
  raw: ...
}
```

`accountId` 指向 BotCord agent id，所以现有 managed route `{ match: { accountId } }` 会把消息交给该 agent 当前绑定的 runtime。这是第三方接入落在 channel 层的关键依据：adapter 只负责把平台消息标准化并填对 `accountId`，不用复制 runtime 选择、workspace、policy、session 逻辑。

## 非目标

第一阶段不处理：

- 群聊完整成员同步、联系人关系同步。
- 微信文件、图片、语音、链接卡片等非文本消息。
- 微信公众号、企业微信、个人微信多协议统一抽象。iLink Bot API 先作为唯一微信 provider。
- Hub 托管第三方 secret。secret 只保存在用户本地 daemon。
- 多设备同时轮询同一个第三方 bot token。一个 connection 只允许绑定一个 daemon。

## Daemon 设计

### 配置模型

扩展 `DaemonConfig`：

```ts
export type ThirdPartyGatewayType = "telegram" | "wechat";

export interface ThirdPartyGatewayProfile {
  id: string;
  type: ThirdPartyGatewayType;
  accountId: string;
  label?: string;
  enabled?: boolean;
  secretFile?: string;
  stateFile?: string;
  allowedSenderIds?: string[];
  allowedChatIds?: string[];
  splitAt?: number;
  baseUrl?: string;
}

export interface DaemonConfig {
  // existing fields...
  thirdPartyGateways?: ThirdPartyGatewayProfile[];
}
```

说明：

- `id` 是 channel id，建议由 Hub 生成，例如 `gw_wechat_...`。
- `type` 决定 adapter factory。
- `accountId` 是 BotCord agent id。
- `secretFile` 通常不需要写入 config，由 daemon 自动派生为 `~/.botcord/daemon/gateways/{id}.json`；只有用户手动迁移密钥目录时才显式配置。
- `stateFile` 通常不需要写入 config，由 daemon 自动派生为 `~/.botcord/daemon/gateways/{id}.state.json`。
- `allowedSenderIds` 是本地入站白名单。空数组默认拒绝所有人，避免首次接入误暴露。
- `allowedChatIds` 主要用于 Telegram 群聊/频道场景。
- provider cursor 不放在 config 或 secret 中，放在 `stateFile`，避免高频重写配置/密钥文件。微信是 `get_updates_buf`，Telegram 是 `offset`。

`toGatewayConfig()` 改为合并两类 channel：

```ts
const botcordChannels = agentIds.map((agentId) => ({
  id: agentId,
  type: "botcord",
  accountId: agentId,
  agentId,
}));

const thirdPartyChannels = (cfg.thirdPartyGateways ?? [])
  .filter((g) => g.enabled !== false)
  .map((g) => ({
    id: g.id,
    type: g.type,
    accountId: g.accountId,
    ...g,
  }));
```

### Channel factory

`startDaemon()` 当前的 `createChannel` 固定返回 `createBotCordChannel()`。需要改成按 `chCfg.type` 分发：

```ts
switch (chCfg.type) {
  case "botcord":
    return createBotCordChannel(...);
  case "telegram":
    return createTelegramChannel(...);
  case "wechat":
    return createWechatChannel(...);
  default:
    throw new Error(`unknown channel type ${chCfg.type}`);
}
```

建议新增：

- `packages/daemon/src/gateway/channels/telegram.ts`
- `packages/daemon/src/gateway/channels/wechat.ts`
- `packages/daemon/src/gateway/channels/secret-store.ts`

### WeChat channel adapter

`createWechatChannel()` 负责：

- 读取 `secretFile` 中的 `botToken`。
- 建立 HTTP client。
- 循环调用 `POST /ilink/bot/getupdates`。
- 把文本消息转成 `GatewayInboundEnvelope`。
- `send()` 中调用 `POST /ilink/bot/sendmessage`。
- `typing()` 中调用 `getconfig` / `sendtyping`，并缓存 `typing_ticket`。

微信入站消息过滤：

- 只处理 `message_type === 1`。
- 必须有 `from_user_id`。
- 必须有 `context_token`。
- 必须能从 `item_list[].type === 1` 中提取文本。
- `from_user_id` 必须在 `allowedSenderIds` 中。

微信 outbound 需要保存 `context_token`。不能只按 `conversationId` 维护“最近 context”，否则同一用户连续发消息时，后来的入站可能覆盖旧 context，导致旧 turn 的回复绑定到错误窗口。

建议在 adapter 内维护 trace 级上下文缓存：

```ts
Map<traceId, { contextToken: string; fromUserId: string; updatedAt: number }>
```

收到入站消息时生成 `message.trace.id`，并把该 trace 绑定到入站消息的 `context_token`。`send()` 时按 `GatewayOutboundMessage.traceId` 查找对应 context。TTL 建议 30 分钟。如果过期或缺失，返回明确错误并记录日志。第一阶段只支持“回复由入站消息触发的 turn”，不支持 daemon 主动向微信用户发起消息。

如果当前 `GatewayOutboundMessage.traceId` 在某些路径上为空，需要先补齐 dispatcher 的 trace 透传契约，再实现 WeChat adapter；不要退回到 conversation 级最近缓存作为默认路径。

微信消息 ID：

```ts
const messageId =
  typeof msg.client_id === "string" ? msg.client_id :
  `wechat:${fromUserId}:${receivedAt}`;
```

WeChat 会话 ID：

```ts
conversation.id = `wechat:user:${fromUserId}`;
conversation.kind = "direct";
```

长回复分片：

- iLink 没有 message edit / native streaming。
- daemon dispatcher 最终会调用 `send()` 输出完整文本。
- `send()` 内按 `splitAt` 分片，默认 1800 字符，优先按换行切。

### Telegram channel adapter

Telegram MVP 可以照 `glance/remote` 使用 polling：

- `getUpdates` 长轮询。
- `sendMessage` 发最终回复。
- 可选 `sendChatAction` 实现 typing。
- 白名单用 `allowedSenderIds` 或 `allowedChatIds`。
- `offset` 持久化到 `stateFile`，避免 daemon 重启后重放最后一批 update。

Telegram 支持 message edit，但第一阶段不需要接入 streamBlock。统一和微信一样只发送最终回复，降低行为差异。

Telegram 会话 ID 规范：

```ts
conversation.id = update.message.chat.type === "private"
  ? `telegram:user:${chatId}`
  : `telegram:group:${chatId}`;
conversation.kind = update.message.chat.type === "private" ? "direct" : "group";
sender.id = `telegram:user:${fromUserId}`;
```

所有 provider 的 conversation id 必须带 provider 前缀，避免污染 session-store key。

### 状态与持久化

`ChannelStatusSnapshot` 当前没有 index signature；实现时需要先显式扩展 optional 字段，或为该 interface 增加 `[key: string]: unknown`。建议优先显式增加这些字段，便于 frontend 类型收敛：

- `provider?: "wechat" | "telegram"`
- `lastPollAt?: number`
- `lastInboundAt?: number`
- `lastSendAt?: number`
- `authorized?: boolean`

provider cursor 应持久化到本地 state 文件，而不是 secret/config 文件：

```ts
interface ThirdPartyGatewayState {
  cursor?: string;
  providerState?: Record<string, unknown>;
  updatedAt: string;
}
```

写入频率要节流，例如每次变化后 debounce 1 秒。这样避免长轮询频繁重写 `config.json`，也避免把运行态混进密钥文件。adapter 负责解释 cursor 含义：WeChat 使用 `get_updates_buf`，Telegram 使用 `offset`。

## Control Plane 设计

新增 control frame：

```ts
CONTROL_FRAME_TYPES.LIST_GATEWAYS = "list_gateways";
CONTROL_FRAME_TYPES.UPSERT_GATEWAY = "upsert_gateway";
CONTROL_FRAME_TYPES.REMOVE_GATEWAY = "remove_gateway";
CONTROL_FRAME_TYPES.TEST_GATEWAY = "test_gateway";
CONTROL_FRAME_TYPES.GATEWAY_LOGIN_START = "gateway_login_start";
CONTROL_FRAME_TYPES.GATEWAY_LOGIN_STATUS = "gateway_login_status";
```

登录 frame 做成 provider-generic，WeChat 只是第一种使用者。后续 LINE / Discord OAuth 不需要再加一组专属 frame。

### `upsert_gateway`

Hub -> daemon：

Telegram 创建或显式 rotate token 时携带 `secret.botToken`：

```json
{
  "id": "gw_telegram_xxx",
  "type": "telegram",
  "accountId": "ag_xxx",
  "label": "Telegram Bot",
  "enabled": true,
  "secret": {
    "botToken": "..."
  },
  "settings": {
    "allowedSenderIds": ["123456789"]
  }
}
```

WeChat 不由 Hub/浏览器携带 `botToken`。扫码确认后，daemon 已经在 login session 中持有 token；`upsert_gateway` 只传 `loginId`：

```json
{
  "id": "gw_wechat_xxx",
  "type": "wechat",
  "accountId": "ag_xxx",
  "label": "Personal WeChat",
  "enabled": true,
  "loginId": "wxl_...",
  "settings": {
    "baseUrl": "https://ilinkai.weixin.qq.com",
    "allowedSenderIds": ["xxx@im.wechat"],
    "splitAt": 1800
  }
}
```

daemon 行为：

1. 校验 `accountId` 是本 daemon 已绑定 agent。
2. 按 provider 解析 secret 来源：
   - Telegram：创建或 rotate token 时从 `secret.botToken` 读取；仅修改 label、白名单、enabled 时不要求重传 token。
   - WeChat：从 `loginId` 对应的 daemon login session 读取，且 login session 的 `accountId` 必须匹配请求的 `accountId`。
3. 写 `~/.botcord/daemon/gateways/{id}.json`，权限 `0600`。
4. 更新 `config.json.thirdPartyGateways`。
5. 如果 enabled，调用 `gateway.addChannel(...)`。
6. 返回 connection 状态。

### `remove_gateway`

daemon 行为：

1. `gateway.removeChannel(id)`。
2. 从 `config.json.thirdPartyGateways` 删除。
3. 删除本地 secret 文件，或按参数保留。

### 微信扫码登录

微信登录比 Telegram 多一步二维码流程。建议由 daemon 发起，因为它最终持有 bot token。

`gateway_login_start` for WeChat：

```json
{
  "provider": "wechat",
  "accountId": "ag_xxx",
  "gatewayId": "gw_wechat_xxx",
  "baseUrl": "https://ilinkai.weixin.qq.com"
}
```

daemon：

1. 调 `GET /ilink/bot/get_bot_qrcode?bot_type=3`
2. 缓存 login session：

```ts
{
  loginId: string;
  accountId: string;
  gatewayId?: string;
  provider: "wechat";
  qrcode: string;
  baseUrl: string;
  botToken?: string;
  tokenPreview?: string;
  expiresAt: number;
}
```

`gateway_login_status` 只能查询同一个 `loginId`；`upsert_gateway` 必须带同一个 `accountId`，daemon 侧校验匹配后才能取出 `botToken` 写入 secret。

3. 返回：

```json
{
  "loginId": "wxl_...",
  "qrcode": "...",
  "qrcodeUrl": "..."
}
```

`gateway_login_status`：

```json
{
  "provider": "wechat",
  "loginId": "wxl_..."
}
```

daemon：

1. 调 `GET /ilink/bot/get_qrcode_status?qrcode=...`
2. 如果 `confirmed`，返回 masked token 状态，不把 token 给 Hub：

```json
{
  "status": "confirmed",
  "baseUrl": "https://ilinkai.weixin.qq.com",
  "tokenPreview": "abcd...wxyz"
}
```

随后前端提交“保存连接”，Hub 发送 `upsert_gateway`，payload 中包含 `loginId` 但不包含 bot token。daemon 校验 `loginId`、`accountId`、`provider` 后，从 login session 内取 bot token 写入本地 secret。这样 bot token 不会经过浏览器和 Hub DB。

## Hub / Backend 设计

新增表：

```sql
create table agent_gateway_connections (
  id text primary key,
  user_id uuid not null,
  agent_id text not null references agents(agent_id),
  daemon_instance_id text not null references daemon_instances(id),
  provider text not null,
  label text,
  status text not null default 'pending',
  enabled boolean not null default true,
  config_json jsonb not null default '{}',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

`config_json` 不存 secret，只存：

```json
{
  "baseUrl": "https://ilinkai.weixin.qq.com",
  "allowedSenderIds": ["xxx@im.wechat"],
  "splitAt": 1800,
  "tokenPreview": "abcd...wxyz"
}
```

### Source of Truth

推荐第一阶段采用 Hub 作为 metadata source of truth：

- Hub DB 保存 connection metadata：provider、label、enabled、白名单、baseUrl、splitAt、tokenPreview、status。
- daemon `config.json.thirdPartyGateways[]` 是本地 cache + daemon 重启启动种子。
- 用户在 dashboard 修改配置时，路径是 Hub API -> daemon control frame -> daemon 写本地 cache；Hub 在 daemon ack 成功后提交 metadata。
- 不建议把 CLI 直接编辑 `config.json.thirdPartyGateways[]` 作为第一阶段支持路径。若用户手动编辑，daemon 可以启动时读取，但下一次 dashboard 保存会以 Hub metadata 覆盖。

这个取舍让 dashboard 展示、权限和审计保持一致；代价是 daemon offline 时只能读 metadata，无法创建/扫码/启停/删除本地 channel。

### Hub 介入取舍

技术上也可以做纯 daemon-local 配置，由 CLI 或本地 Web UI 直接写第三方连接。本文档选择 Hub 介入，原因是：

- dashboard 已经是 agent 设置入口，用户无需切换到本机 CLI。
- Hub 能展示跨设备连接状态和最近错误。
- 未来支持团队共享 agent、审计和权限时，metadata 已经在服务端。

代价：

- 多一层 control-frame ack / timeout。
- 需要一张 metadata 表和 BFF/API。
- daemon offline 时大部分写操作必须禁用。

如果第一阶段只服务单用户单机，也可以先降级为 daemon-local MVP：不建 `agent_gateway_connections` 表，只通过现有 daemon control frame list/upsert/remove。后续再把 metadata 提升到 Hub DB。两条路线的 daemon adapter 和 local secret/state store 可以复用。

API：

- `GET /api/agents/{agent_id}/gateways`
- `POST /api/agents/{agent_id}/gateways`
- `PATCH /api/agents/{agent_id}/gateways/{gateway_id}`
- `DELETE /api/agents/{agent_id}/gateways/{gateway_id}`
- `POST /api/agents/{agent_id}/gateways/{gateway_id}/test`
- `POST /api/agents/{agent_id}/gateways/wechat/login/start`
- `POST /api/agents/{agent_id}/gateways/wechat/login/status`

BFF 可以保留 provider-specific URL 以简化 frontend；Hub -> daemon control frame 使用 provider-generic 的 `gateway_login_start/status`。

权限规则：

- 当前 user 必须拥有 agent。
- agent 必须是 daemon-hosted：`hosting_kind == "daemon"` 且有 `daemon_instance_id`。
- daemon 必须在线，除非只是读取已保存 connection 列表。
- provider 类型必须在 allowlist：`telegram`、`wechat`。

失败语义：

- daemon offline：`409 daemon_offline`
- provider auth 失败：`400 provider_auth_failed`
- daemon ack timeout：`504 daemon_ack_timeout`
- daemon 返回错误：`502 daemon_gateway_failed`

## Frontend 设计

入口放在 `AgentSettingsDrawer`，新增第三个 tab：

```ts
type Tab = "profile" | "policy" | "gateways";
```

Tab 文案建议：

- 中文：`接入`
- 英文：`Channels`

### 接入页结构

整体布局保持紧凑设置面板，不做大段说明页：

1. 默认入口
   - BotCord 内置入口只读显示。
   - 展示当前 agent id 和“始终启用”状态。
   - 不提供删除，因为这是 BotCord agent 的基础数据面入口。

2. 已连接入口列表
   - 每个连接显示 provider icon/name、label、所属 daemon、状态和最近错误。
   - 状态枚举：`active`、`disabled`、`error`、`pending`。
   - 操作：
     - 启用/停用：`PATCH gateway enabled`
     - 测试连接：`POST test_gateway`
     - 删除：打开确认弹窗，确认后删除本地 secret 和 hot-plug channel
   - 错误态示例：
     - `token invalid`
     - `poll failed`
     - `daemon offline`
     - `missing allowed sender ids`

3. 添加入口
   - 点击 `添加接入` 展开内联表单或打开轻量 dialog。
   - provider 用 segmented control：`微信` / `Telegram`。
   - 不同 provider 展示不同配置表单。

### 微信交互流程

微信是唯一需要扫码登录的 provider，流程如下：

1. 用户进入 `AgentSettingsDrawer` 的 `接入` tab。
2. 点击 `添加接入`，选择 `微信`。
3. 点击 `扫码登录`。
4. 前端调用 `POST /api/agents/{agent_id}/gateways/wechat/login/start`。
5. 后端通过 daemon control frame 调用 `gateway_login_start`，参数包含 `provider: "wechat"`。
6. daemon 调用 iLink `get_bot_qrcode`，返回：
   - `loginId`
   - `qrcode`
   - `qrcodeUrl`
   - `expiresAt`
7. UI 显示二维码或二维码 URL，并进入轮询状态。
8. 前端每 2 秒调用 `wechat/login/status`。
9. UI 状态机：
   - `等待扫码`
   - `等待手机确认`
   - `已登录`
   - `已过期`
   - `登录失败`
10. 登录确认后：
    - 不展示完整 bot token。
    - 只显示 `已授权` 和 token preview，例如 `abcd...wxyz`。
11. 用户填写：
    - 接入名称，例如“我的微信”
    - 允许的微信用户 ID，格式 `xxx@im.wechat`
    - 是否立即启用
12. 点击保存。
13. Hub 发送 `upsert_gateway` 给 daemon。
14. daemon 从 login session 中取 bot token，写入本地 secret 文件，并 hot-plug `wechat` channel。

关键约束：

- bot token 不经过浏览器，也不写入 Hub DB。
- 登录确认后如果用户关闭 dialog，daemon 可短期保留 login session，建议 TTL 5 分钟。
- 白名单为空时保存按钮默认禁用；如果产品要允许保存，则必须明确提示“将拒绝所有消息”。

### Telegram 交互流程

Telegram 不需要扫码：

1. 用户进入 `接入` tab。
2. 点击 `添加接入`，选择 `Telegram`。
3. 表单字段：
   - Bot token
   - 接入名称
   - allowed chat/user ids
   - 是否立即启用
4. 点击保存。
5. Hub 把 token 通过 `upsert_gateway` 转发给 daemon。
6. daemon 本地写 secret 并 hot-plug `telegram` channel。
7. UI 只保存并展示 token preview，不回显完整 token。

### 已连接入口管理

每个已连接入口的操作语义：

- 启用：daemon 将 connection 标记为 enabled，并 `gateway.addChannel(...)`。
- 停用：daemon 将 connection 标记为 disabled，并 `gateway.removeChannel(...)`，本地 secret 保留。
- 测试：daemon 做 provider 级健康检查，避免消费消息或推进游标。
  - 微信：优先调用无消费副作用的 token/config 校验接口；如果 iLink 没有合适接口，则返回运行中 adapter 最近一次 poll 状态，不另起 `getupdates`。
  - Telegram：调用 `getMe`。
- 删除：daemon 停 channel、删除 `config.json.thirdPartyGateways[]` 条目，并删除本地 secret 文件。

删除前需要确认弹窗，文案要明确：

- 删除只移除第三方接入。
- 不删除 BotCord agent。
- 不删除 agent workspace、memory、runtime 配置。

### 安全默认 UI 行为

- 第三方接入默认需要白名单。
- token 输入框只在创建/替换时出现；已保存连接不回显 token。
- token preview 只用于确认当前连接已经授权。
- daemon offline 时：
  - 已连接列表仍可读。
  - 创建、扫码、启用、停用、测试、删除都禁用，并显示 daemon offline。
- provider error 时：
  - 卡片保留，显示 `last_error`。
  - 提供“测试连接”和“重新授权/替换 token”入口。

### Frontend store

新增 `useAgentGatewayStore`：

```ts
interface AgentGatewayConnection {
  id: string;
  provider: "telegram" | "wechat";
  label: string | null;
  status: "pending" | "active" | "error" | "disabled";
  enabled: boolean;
  config: Record<string, unknown>;
  last_error?: string | null;
}
```

actions：

- `load(agentId)`
- `startWechatLogin(agentId)`
- `pollWechatLogin(agentId, loginId)`
- `create(agentId, input)`
- `patch(agentId, gatewayId, patch)`
- `enable(agentId, gatewayId)`
- `disable(agentId, gatewayId)`
- `remove(agentId, gatewayId)`
- `test(agentId, gatewayId)`

## Security

### Secret 存储

- Telegram bot token、WeChat bot token 只写 daemon 本地。
- 文件默认路径：`~/.botcord/daemon/gateways/{gateway_id}.json`
- 文件权限：`0600`
- 目录权限：`0700`
- Hub DB 只保存 masked token preview。

### 入站白名单

第一阶段必须默认拒绝所有第三方 sender，用户显式配置后才处理：

- Telegram：`allowedChatIds` / `allowedUserIds`
- WeChat：`allowedSenderIds`，格式如 `xxx@im.wechat`

拒绝时：

- Telegram 可以静默或回复 unauthorized。
- 微信参考 `glance/remote` 可以回复 unauthorized，但产品上建议默认静默，避免泄露 bot 存在。

### Prompt 注入

第三方输入均视为非 owner 输入：

- 不能假设 botcord channel 的 composer 会自动覆盖第三方 adapter。每个 third-party adapter 必须显式注册同等强度的 sanitize + user-turn composition。
- sanitize 规则至少要复用 `sanitizeUntrustedContent()` 等价能力，避免把 provider raw fields、用户名、群名直接作为可信 system text 注入。
- user-turn composition 需要标明消息来源 provider、sender id/name、conversation kind，并把用户文本作为不可信内容包裹。
- attention gate 仍按 `accountId` + conversation policy 执行。
- `sender.kind = "user"`。
- 不因为消息来自白名单就提升到 owner trust。

### 多实例冲突

同一个第三方 token 不应被多个 daemon 同时 polling：

- Hub 表中 `gateway_id` 绑定唯一 `daemon_instance_id`。
- UI 禁止把同一 connection 迁移到另一个 daemon。
- 迁移需要先 remove，再重新登录/保存。

老 daemon 离线、新 daemon 接管是独立的 takeover 流程，不放入第一阶段自动处理。未来如果支持，需要 dashboard 显式确认：

- 旧 daemon offline 超过 N 秒后允许 reassign。
- 新 daemon 重新登录/保存 secret。
- provider cursor/context cache 默认丢弃；除非后续设计跨 daemon state migration。

## 下游影响清单

第三方消息第一阶段不落 Hub message 表，只进入 daemon gateway -> runtime。这会影响以下下游，需要实现前逐项确认：

- ActivityTracker：daemon 侧 `onInbound` 仍会记录 activity，conversation id 必须 provider-prefixed。
- Loop risk：`recordLoopRiskInbound` / `recordLoopRiskOutbound` 仍按 session key 工作，session key 必须区分 provider。
- Room context / cross-room digest：第三方 direct conversation 不是 BotCord room，room-context fetcher 应允许返回 empty context，不应反复打 Hub room API 报错。
- Dashboard message history：不会自动展示第三方微信/Telegram对话。第一阶段 UI 只展示 connection 状态，不展示聊天记录。
- Policy：attention policy 仍可按 agent global policy 生效；per-room override 不适用于第三方 conversation，除非后续为 provider conversation 建立 policy row。

## 测试计划

Daemon:

- `wechat-channel.test.ts`
  - `getupdates` normalize。
  - 缺少 `context_token` 丢弃。
  - 非白名单丢弃。
  - `send()` 按 `traceId` 带回入站消息绑定的 `context_token`。
  - 长回复分片。
  - typing ticket 缓存。
- `telegram-channel.test.ts`
  - polling normalize。
  - `offset` 持久化到 state file。
  - 白名单过滤。
  - sendMessage 调用。
- `daemon-config-map.test.ts`
  - `thirdPartyGateways` 被映射成 channels。
  - disabled gateway 不启动。
- `gateway-state-store.test.ts`
  - cursor/state 写入不修改 `config.json` 和 secret file。
  - debounce 写入。
- `provision/control-frame` tests
  - upsert/remove/test gateway。
  - secret 文件权限。
  - WeChat `loginId` 和 `accountId` 不匹配时拒绝 upsert。

Backend:

- connection CRUD 权限。
- daemon offline 返回 409。
- 微信 login start/status 只透传二维码状态，不落库 secret。
- create 成功后 DB 保存 metadata。

Frontend:

- `AgentSettingsDrawer` 新 tab 渲染。
- 微信扫码状态流转。
- Telegram token form 不在 UI 中回显完整 token。
- provider-specific form 抽象，微信扫码表单和 Telegram token 表单互不耦合。

## 推荐实施顺序

1. Daemon channel factory 泛化：支持 `botcord` 之外的 channel type。
2. 引入 `thirdPartyGateways` 配置和本地 secret store。
3. 实现 WeChat adapter，先只做文本 direct message。
4. 实现 control frames：wechat login、upsert/remove/list/test。
5. Backend 新增 `agent_gateway_connections` 和 API。
6. Frontend `AgentSettingsDrawer` 增加 `接入` tab，并抽出 provider-specific form。
7. Telegram adapter 复用同一套 control/API，接入自己的 token 表单。

## Open Questions

- 微信 iLink bot token 是否有明确过期时间和 refresh 机制？参考代码只保存 `bot_token`，未处理 refresh。
- `context_token` 有效期多长？需要实测后确定缓存 TTL。
- 微信群聊是否会通过同一 API 进入？若支持，需要确认消息字段里是否有 room/conversation id。
- 是否允许一个 agent 同时启用多个微信账号？技术上可以，产品上需要限制和计费策略。
- BotCord dashboard 是否需要显示第三方消息历史？第一阶段可以只让 daemon 转发到 runtime，不落 Hub message 表。
- 老 daemon 离线后，新 daemon 是否允许接管同一个 third-party connection？若允许，cursor/context 状态是否丢弃还是迁移？
