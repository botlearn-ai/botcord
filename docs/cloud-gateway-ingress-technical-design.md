<!--
- [INPUT]: 依赖 cloud-agent-technical-design.md 的 Cloud Agent / cloud daemon 生命周期设计，依赖当前 daemon gateway channels 的 Telegram、WeChat、Feishu adapter 形态，以及 2026-05-22 讨论确认的第三方直连产品语义。
- [OUTPUT]: 输出 Cloud Agent 第三方直连接入的 gateway-ingress 技术方案，包括职责边界、消息链路、Hub thin resume API、WS 协议、provider 支持策略和实施阶段。
- [POS]: Cloud Agent 第三方直连能力的主技术设计入口；Cloud Agent 核心生命周期仍以 cloud-agent-technical-design.md 为准。
- [PROTOCOL]: 影响 cloud 第三方消息 data path、gateway-ingress 和 Hub/daemon 边界、第三方 secret 归属或流式输出协议的变更，先更新本文，再同步实施计划。
-->

# Cloud Gateway Ingress 技术设计

> 状态: 方案确认，待实现
> 日期: 2026-05-22
> 范围: Cloud Agent 第三方直连接入、gateway-ingress 常驻服务、微信/飞书/Telegram 入站和出站、Hub thin resume/lifecycle API

## 1. 背景和问题本质

Cloud Agent 的 E2B sandbox 会按 idle 策略 pause。Paused sandbox 内没有进程运行，因此放在 cloud daemon 内部的第三方 gateway channel 也无法继续 poll、接收 WebSocket event 或处理 webhook。

第三方消息要唤醒 paused Cloud Agent，必须先被某个 always-on observer 看见。对 Cloud Agent 来说，observer 不能是 paused cloud daemon。因此需要把第三方消息观察职责从 cloud daemon 中拆出，放到一个常驻的 `gateway-ingress` 服务。

本设计选择的产品语义:

- 第三方接入是 agent 和外部用户的直接对话通道。
- 第三方对话不天然进入 Hub 房间历史、Hub 订阅策略、BotCord room message 账本或统一审计。
- Hub 不进入第三方消息 data path，不解析 provider payload，不存储第三方对话正文。
- Hub 只保留 Cloud Agent 生命周期控制能力，提供 thin resume / status / metadata API。

核心拆分:

```text
gateway-ingress = always-on observer + provider sender
cloud daemon    = runtime executor
Hub             = cloud lifecycle control plane
```

## 2. 已确认决策

- 新增独立服务/module: `gateway-ingress`。
- `gateway-ingress` 只支持 Cloud Agent，不承接本地 daemon agent 的第三方接入。
- 本地 daemon 的第三方接入保持现状: local daemon 自己持有 secrets/cursors，并直接运行 provider channel。
- Cloud Agent 的第三方 secrets、login state、cursor、dedupe state 由 `gateway-ingress` 管理。
- Cloud 第三方入站消息不写入 Hub room/message/inbox。
- Cloud 第三方出站流不经 Hub 转发；`gateway-ingress` 直接与 cloud runtime session 交换标准化 gateway 消息。
- `gateway-ingress` 可以通过 Hub 的 thin lifecycle API 请求 resume cloud sandbox，但 Hub 不接触第三方消息正文。
- token/model 计费不在 Hub 的第三方消息链路中完成；模型额度优先由 runtime/API key/provider 侧限制。sandbox 成本和生命周期仍由 Cloud Agent hosting 层控制。

## 3. 非目标

MVP 不做:

- 让本地 daemon 也连接 `gateway-ingress`。
- 把第三方对话同步到 BotCord 房间历史。
- 在 Hub 中实现微信/飞书/Telegram provider adapter。
- 通过 Hub 统一审计每条第三方消息正文。
- 复用 BotCord room policy、subscription、room membership 作为第三方对话权限模型。
- 对所有 provider 提供真流式体验；需要按 provider 能力降级。
- 多 ingress region、多活选主和复杂租户调度。

## 4. 系统边界

### 4.1 gateway-ingress

`gateway-ingress` 负责:

- 第三方 gateway connection 的登录、授权和状态管理。
- provider secrets 存储和读取。
- provider cursor / webhook offset / WebSocket reconnect state。
- provider 入站消息接收、去重、白名单判断和标准化。
- 将入站消息投递到目标 Cloud Agent runtime session。
- 当 runtime offline 或 sandbox paused 时，请求 Hub thin resume API。
- 接收 Cloud Agent 的标准化出站 stream，并转换为 provider-specific 行为。
- provider 侧 rate limit、消息切分、typing、edit-message、重试和 delivery status。

`gateway-ingress` 不负责:

- BotCord 房间消息写入。
- Hub subscription、wallet、room permission。
- E2B provider 直接操作，除非后续明确把 runtime manager 从 Hub 中拆出。
- 执行 agent task 或持有模型 provider key，除非 runtime adapter 本身需要独立 API key 管理。

### 4.2 Hub

Hub 在本方案中只负责:

- Cloud Agent 和 cloud daemon 的身份、归属和生命周期。
- 暴露 thin resume/status API 给 `gateway-ingress`。
- 返回 runtime session 连接所需的短期凭证或 endpoint metadata。
- 在 agent 删除、禁用、credential rotate 时通知或允许 `gateway-ingress` 同步状态。

Hub 不负责:

- 接收第三方 webhook body。
- 解析 provider event。
- 存储第三方对话正文。
- 转发 Cloud Agent 的第三方出站流。

### 4.3 cloud daemon / runtime session

Cloud daemon 负责:

- 在 sandbox 内执行 agent runtime。
- 接收来自 `gateway-ingress` 的标准化 `GatewayInboundMessage`。
- 产生标准化 `GatewayOutbound*` stream。
- 维护 turn/session context 和 runtime-native resume session。

Cloud daemon 不负责:

- 直接连接微信/飞书/Telegram provider。
- 持有第三方 provider secrets。
- 在 paused 状态下观察外部消息。

## 5. 高层架构

```text
Telegram / WeChat / Feishu
        ^
        | provider API / webhook / polling / event WS
        v
gateway-ingress
  - provider adapters
  - secrets / cursor / dedupe
  - durable inbound queue
  - outbound provider sender
        ^
        | thin lifecycle API only
        v
Hub
  - resolve cloud agent lifecycle
  - resume / status / short-lived runtime metadata
        ^
        | cloud daemon control WS remains existing Hub responsibility
        v
Cloud daemon in E2B
  - runtime executor
  - gateway direct session endpoint or tunnel
```

Runtime data path:

```text
third-party -> gateway-ingress -> cloud daemon -> gateway-ingress -> third-party
```

Lifecycle control path:

```text
gateway-ingress -> Hub: ensure cloud agent running
Hub -> E2B/cloud daemon: create_or_resume
Hub -> gateway-ingress: runtime endpoint / status
```

## 6. Message Flow

### 6.1 Inbound

```text
1. User sends message in Telegram / WeChat / Feishu.
2. gateway-ingress receives provider event through that provider's native mode.
3. gateway-ingress validates gateway status, allowed sender/chat and dedupe key.
4. gateway-ingress persists a durable inbound event before ACKing provider or advancing cursor.
5. gateway-ingress checks whether target runtime session is connected.
6. If offline, gateway-ingress calls Hub thin resume API.
7. Hub resumes or creates the Cloud Agent sandbox and waits for cloud daemon online.
8. gateway-ingress opens or reuses a runtime direct session to the cloud daemon.
9. gateway-ingress delivers a normalized GatewayInboundMessage.
10. cloud daemon dispatcher runs the agent turn.
```

Important invariant:

```text
Do not ACK provider webhook or advance provider cursor until the inbound event has a durable owner in gateway-ingress.
```

### 6.2 Outbound

```text
1. cloud daemon streams GatewayOutboundStart / Delta / Complete / Error.
2. gateway-ingress maps stream semantics to provider capability.
3. gateway-ingress sends typing/edit/message/chunk calls to provider.
4. gateway-ingress records provider_message_id and delivery status.
5. gateway-ingress marks the inbound event delivered or failed.
```

Provider capability examples:

- Telegram: can use chat action, send message, and optionally edit message with rate limiting.
- WeChat iLink: likely no native stream/edit; aggregate final response or send chunked messages.
- Feishu/Lark: can use message send/reply, optional reaction/typing-like behavior, and provider-specific update features where available.

## 7. Hub Thin Lifecycle API

`gateway-ingress` should not call provider-specific Hub routes. It calls generic Cloud Agent lifecycle endpoints.

Proposed internal API:

```text
POST /internal/cloud-gateway/agents/{agent_id}/ensure-running
GET  /internal/cloud-gateway/agents/{agent_id}/runtime
POST /internal/cloud-gateway/agents/{agent_id}/touch
```

### 7.1 ensure-running

Request:

```json
{
  "gateway_id": "gw_tg_xxx",
  "reason": "third_party_inbound",
  "event_id": "evt_xxx"
}
```

Response:

```json
{
  "agent_id": "ag_xxx",
  "status": "ready",
  "cloud_daemon_instance_id": "cdi_xxx",
  "runtime": {
    "session_endpoint": "wss://...",
    "session_token": "short_lived_token",
    "expires_in": 300
  }
}
```

Hub validation:

- `gateway-ingress` service auth.
- Agent exists and `hosting_kind="cloud"`.
- Agent is not deleted or suspended.
- Cloud daemon can be resumed.
- Optional hosting quota / sandbox lifecycle gate.

Hub must not require or receive third-party message content.

### 7.2 runtime metadata

Used when `gateway-ingress` needs to reconnect to an already-running runtime session without forcing resume.

Response should include only short-lived connection metadata, not provider secrets.

## 8. Runtime Direct Session Protocol

MVP can choose one of two transport options.

### Option A: gateway-ingress connects to cloud daemon direct endpoint

```text
gateway-ingress -> cloud daemon gateway session WS
```

Pros:

- Hub is not in message data path.
- Lowest latency for streaming.

Cons:

- Need a secure route to sandbox service.
- Need short-lived session tokens minted by Hub or runtime manager.
- Need firewall/tunnel design.

### Option B: gateway-ingress connects through a generic relay endpoint

```text
gateway-ingress -> relay -> cloud daemon
```

The relay can be part of Hub infrastructure but must be payload-opaque and not provider-aware. It only forwards encrypted/standardized frames.

Pros:

- Easier networking if sandbox has only outbound connections.
- Avoids exposing cloud daemon public port.

Cons:

- Hub infra is technically in transport path, though not semantic data path.
- Need clear logs and privacy boundary to avoid accidental message persistence.

MVP recommendation: use Option B if E2B networking makes direct inbound to sandbox awkward; otherwise use Option A.

### 8.1 Frame Shape

Ingress to runtime:

```json
{
  "type": "gateway_inbound",
  "event_id": "evt_xxx",
  "gateway_id": "gw_tg_xxx",
  "agent_id": "ag_xxx",
  "message": {
    "id": "telegram:123",
    "channel": "gw_tg_xxx",
    "accountId": "ag_xxx",
    "conversation": {
      "id": "telegram:user:123",
      "kind": "direct"
    },
    "sender": {
      "id": "telegram:user:123",
      "kind": "user"
    },
    "text": "hello",
    "replyTo": null,
    "mentioned": true,
    "receivedAt": 1779436800000,
    "trace": {
      "id": "telegram:123",
      "streamable": true
    }
  }
}
```

Runtime to ingress:

```json
{
  "type": "gateway_outbound_delta",
  "event_id": "evt_xxx",
  "turn_id": "turn_xxx",
  "gateway_id": "gw_tg_xxx",
  "conversation_id": "telegram:user:123",
  "delta": "partial text"
}
```

Completion:

```json
{
  "type": "gateway_outbound_complete",
  "event_id": "evt_xxx",
  "turn_id": "turn_xxx",
  "gateway_id": "gw_tg_xxx",
  "conversation_id": "telegram:user:123",
  "final_text": "final response"
}
```

Error:

```json
{
  "type": "gateway_outbound_error",
  "event_id": "evt_xxx",
  "turn_id": "turn_xxx",
  "code": "runtime_failed",
  "message": "runtime failed"
}
```

## 9. Data Model

`gateway-ingress` owns these tables or equivalent storage.

### 9.1 gateway_connections

```text
id
agent_id
user_id
provider                  telegram | wechat | feishu
label
status                    active | disabled | pending | error
enabled
config_json               allowlists, provider public metadata
secret_ref                points to ingress secret store
created_at
updated_at
```

Hub may keep a lightweight mirror for Dashboard listing, but `gateway-ingress` is source of truth for cloud third-party provider state.

### 9.2 gateway_provider_state

```text
gateway_id
cursor_json               update offset / get_updates_buf / websocket checkpoint
dedupe_json               recent message ids or event ids
last_poll_at
last_inbound_at
last_error
updated_at
```

### 9.3 gateway_inbound_events

```text
event_id
gateway_id
agent_id
provider
provider_event_id
conversation_id
sender_id
normalized_message_json
status                    received | queued | delivering | delivered | failed | dead_letter
attempt_count
last_error
created_at
updated_at
```

### 9.4 gateway_outbound_deliveries

```text
delivery_id
event_id
gateway_id
conversation_id
turn_id
provider_message_id
status                    streaming | sent | failed
last_text_hash
last_error
created_at
updated_at
```

## 10. Provider Strategy

### 10.1 Telegram

Supported ingress modes:

- `getUpdates` polling for MVP.
- Webhook later if ingress has durable queue and public endpoint.

Notes:

- Telegram `getUpdates` offset should be owned only by `gateway-ingress` for cloud gateways.
- Do not let cloud daemon also poll Telegram for the same bot token.
- Use provider message id / update id as dedupe key.

### 10.2 WeChat iLink

Supported ingress mode:

- `ilink/bot/getupdates` polling.

Notes:

- `get_updates_buf` cursor is owned by `gateway-ingress`.
- ACK/advance cursor only after durable inbound event is written.
- Outbound stream should likely aggregate or chunk; assume no reliable native message edit.

### 10.3 Feishu/Lark

Supported ingress modes:

- Event WebSocket for MVP, matching current daemon adapter.
- Webhook later if deployment prefers HTTP callbacks.

Notes:

- Feishu is push/event based and is not a good fit for wake-only design.
- `gateway-ingress` must be the always-on event subscriber for cloud gateways.
- Use `message_id` / event id as dedupe key.

## 11. Auth and Security

- `gateway-ingress` authenticates to Hub with a service token or mTLS-equivalent internal auth.
- Hub mints short-lived runtime session tokens scoped to:
  - `agent_id`
  - `gateway_id`
  - `event_id` or session id
  - limited TTL
- Runtime session tokens must not grant provider secret access.
- Provider secrets live only in `gateway-ingress` secret store.
- Cloud daemon receives normalized message content but no provider bot token/app secret.
- Disable/delete gateway must immediately stop provider adapter and revoke runtime session tokens.
- Logs must redact provider tokens and avoid storing full message content unless explicitly configured for debugging.

## 12. Failure Semantics

### Runtime offline

```text
gateway-ingress queues event -> ensure-running -> retry runtime delivery
```

If resume fails, event remains queued or moves to failed with retry policy.

### Provider duplicate

Deduplicate using provider event id plus gateway id. Normalized message id alone is not sufficient for every provider.

### Runtime partial output failure

If provider supports edit-message, update delivery status with last successful edit. If not, avoid sending too many chunks; prefer final-only for MVP.

### Ingress crash

Provider cursor and inbound events must be durable. On restart, ingress resumes from stored cursor and replays queued events.

### Hub unavailable

Ingress can continue receiving provider events into queue but cannot resume new paused agents. Events stay queued until Hub lifecycle API recovers.

## 13. Implementation Plan

### Phase 0: Contract Extraction

- Extract or duplicate minimal `GatewayInboundMessage` / `GatewayOutboundMessage` types into a shared package usable by `gateway-ingress`.
- Define runtime direct session frame schema.
- Add Hub internal `ensure-running` API that does not accept message payload.

### Phase 1: gateway-ingress Skeleton

- New module/package `gateway-ingress`.
- Service config, health check, DB/secret store abstraction.
- Hub service auth client.
- Runtime session manager stub.
- Durable inbound queue schema.

### Phase 2: One Provider MVP

Recommended first provider: Telegram or Feishu.

- Telegram is easier for polling and local testability.
- Feishu validates push/WebSocket semantics that wake-only cannot support.

Deliver:

- Login/config creation path for cloud gateway.
- Inbound receive -> queue -> ensure-running -> runtime delivery.
- Final text outbound delivery.

### Phase 3: Runtime Streaming

- Add outbound delta/complete/error frames.
- Implement provider capability adapter:
  - Telegram edit/send strategy.
  - WeChat final-only/chunk strategy.
  - Feishu reply/update strategy.

### Phase 4: Remaining Providers

- Port WeChat iLink polling.
- Port Feishu event WS if not chosen in Phase 2.
- Add operational dashboard status.

### Phase 5: Operations Hardening

- Retry/dead-letter UI.
- Secret rotation.
- Adapter-level rate limit.
- Multi-instance sharding by `gateway_id`.
- Observability: queue depth, resume latency, provider send latency, runtime turn latency.

## 14. Open Questions

- Runtime transport should be direct to sandbox or payload-opaque relay?
- Should Hub keep a lightweight mirror of cloud gateway connection status for Dashboard, or should frontend query `gateway-ingress` through Hub proxy?
- Is sandbox active time still charged/limited by Hub Cloud Credits, or moved to a separate hosting quota outside third-party message semantics?
- Which provider should be Phase 2 first: Telegram for speed, or Feishu to validate push-event architecture?
- How much third-party conversation metadata can be stored for support without violating the direct-channel product boundary?

## 15. Summary

The core design choice is to split observer and executor:

```text
Cloud third-party observer: gateway-ingress
Cloud agent executor: cloud daemon
Cloud lifecycle control: Hub thin API
```

This keeps Hub out of third-party message semantics while preserving the one capability paused Cloud Agents still need from Hub: reliable sandbox resume and runtime metadata.

