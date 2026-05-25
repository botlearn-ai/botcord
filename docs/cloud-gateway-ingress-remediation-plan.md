<!--
- [INPUT]: Based on cloud-gateway-ingress-technical-design.md, current Hub gateway routes, daemon gateway login/session handlers, and the observed early "login session not found or expired" failure for Cloud Agent WeChat setup.
- [OUTPUT]: Remediation plan that moves Cloud Agent third-party setup, login, credential ownership, whitelist discovery, and runtime ingress to gateway-ingress for WeChat, Feishu/Lark, and Telegram.
- [POS]: Implementation guide for correcting the Cloud Agent third-party gateway ownership boundary. The broader architecture remains in cloud-gateway-ingress-technical-design.md.
- [PROTOCOL]: Any implementation that changes Cloud Agent third-party login, provider secret storage, gateway-ingress APIs, or Hub routing must keep this plan and cloud-gateway-ingress-technical-design.md aligned.
-->

# Cloud Gateway Ingress 整改技术方案

> 状态: 待实现
> 日期: 2026-05-25
> 范围: Cloud Agent 的微信、飞书/Lark、Telegram 第三方接入配置闭环与运行时消息接入

## 1. 问题背景

Cloud Agent 的 sandbox 会按 idle 策略 pause。Paused 后，cloud daemon 进程不运行，因此它不能继续轮询第三方平台，也不能持有一个可靠的临时扫码登录 session。

当前 Cloud Agent 第三方接入存在职责错位:

- 保存前的微信/飞书扫码登录由 Hub 控制帧转发给 cloud daemon。
- 临时 `loginId -> provider credential` 存在 cloud daemon 内存中。
- 保存后的长期消息接入目标却应该由常驻 `gateway-ingress` 完成。
- 如果 cloud daemon 在 5 分钟 TTL 内被 pause、resume、重启、替换，或后续请求路由到另一个 cloud daemon，前端仍持有的 `loginId` 会在 daemon 内存里找不到，表现为 `login session "... " not found or expired`。

这不是单纯的超时问题，而是 Cloud Agent provider credential 的所有权边界错误。

## 2. 整改目标

Cloud Agent 的第三方接入必须满足:

- `gateway-ingress` 是 Cloud Agent 第三方 provider 的唯一常驻 observer。
- `gateway-ingress` 持有 Cloud Agent 第三方 provider secret、cursor、dedupe state、临时登录态和白名单发现状态。
- cloud daemon 只负责 runtime 执行，不负责 provider 登录、轮询、webhook/event WS 或 secret 存储。
- Hub 不保存第三方明文 secret，不解析第三方消息正文；Hub 只负责鉴权、metadata mirror、Cloud Agent lifecycle 和 runtime session token。
- local daemon agent 保持现状，不强制迁移到 `gateway-ingress`。

目标职责边界:

```text
local daemon agent:
  frontend -> Hub -> local daemon
  local daemon owns login/session/secret/provider adapter

cloud agent:
  frontend -> Hub -> gateway-ingress
  gateway-ingress owns login/session/secret/provider adapter
  cloud daemon only executes runtime turns
```

## 3. 总体架构

Cloud Agent 第三方接入分为两条链路。

配置控制链路:

```text
frontend
  -> Hub BFF/API
  -> gateway-ingress setup API
  -> provider login / validation / sender discovery
```

长期消息链路:

```text
provider event/message
  -> gateway-ingress provider adapter
  -> durable inbound event
  -> Hub /internal/cloud-gateway/.../ensure-running
  -> CloudAgentService.resume_cloud_agent(...)
  -> runtime session metadata
  -> gateway-ingress runtime WS
  -> cloud daemon runtime executor
  -> gateway-ingress provider sender
  -> provider
```

关键约束:

- Cloud Agent provider secret 不进入 cloud daemon。
- Cloud Agent provider secret 不进入 Hub DB 明文字段。
- `gateway-ingress` 可以通过 Hub 查询 agent ownership 和 lifecycle metadata，但第三方正文不经过 Hub。
- `gateway-ingress` 在 durable write 成功前不得推进 provider cursor 或 ACK provider webhook。

## 4. API 整改

### 4.1 Hub 路由分流

现有 gateway routes 应按 agent hosting kind 分流。

```text
POST /api/agents/{agent_id}/gateways
POST /api/agents/{agent_id}/gateways/{gateway_id}
POST /api/agents/{agent_id}/gateways/wechat/login/start
POST /api/agents/{agent_id}/gateways/wechat/login/status
POST /api/agents/{agent_id}/gateways/wechat/senders
POST /api/agents/{agent_id}/gateways/feishu/login/start
POST /api/agents/{agent_id}/gateways/feishu/login/status
POST /api/telegram/chat-ids
```

Routing rule:

```text
if agent.hosting_kind == "daemon":
  keep current daemon control-frame behavior

if agent.hosting_kind == "cloud":
  proxy to gateway-ingress setup/config API
```

Hub responsibilities for cloud routes:

- authenticate user and verify agent ownership;
- reject non-cloud/non-daemon unsupported states;
- pass a scoped setup request to `gateway-ingress`;
- keep or update a lightweight Hub mirror row for Dashboard listing;
- never receive or persist provider secret values except opaque IDs/previews returned by `gateway-ingress`.

### 4.2 gateway-ingress setup API

Add an internal setup API, authenticated with `CLOUD_GATEWAY_INGRESS_SECRET` or an equivalent service credential.

```text
POST /internal/gateway-ingress/agents/{agent_id}/gateways/{provider}/login/start
POST /internal/gateway-ingress/agents/{agent_id}/gateways/{provider}/login/status
POST /internal/gateway-ingress/agents/{agent_id}/gateways/{provider}/discover
POST /internal/gateway-ingress/agents/{agent_id}/gateways
PATCH /internal/gateway-ingress/agents/{agent_id}/gateways/{gateway_id}
DELETE /internal/gateway-ingress/agents/{agent_id}/gateways/{gateway_id}
POST /internal/gateway-ingress/agents/{agent_id}/gateways/{gateway_id}/test
```

Common request context forwarded by Hub:

```json
{
  "user_id": "usr_xxx",
  "agent_id": "ag_xxx",
  "hosting_kind": "cloud",
  "request_id": "req_xxx"
}
```

Provider-specific setup endpoints may return provider-specific fields, but they must share these semantics:

- `loginId` is minted and stored by `gateway-ingress`.
- `expiresAt` is computed by `gateway-ingress`.
- `tokenPreview` may be returned after confirmation.
- raw provider credentials are never returned to Hub or frontend.

### 4.3 Hub thin lifecycle API remains separate

Do not overload setup APIs with runtime resume.

Runtime wake still uses:

```text
POST /internal/cloud-gateway/agents/{agent_id}/ensure-running
GET  /internal/cloud-gateway/agents/{agent_id}/runtime
POST /internal/cloud-gateway/agents/{agent_id}/touch
```

`gateway-ingress` setup/config APIs manage provider connection state. `cloud-gateway` lifecycle APIs manage Cloud Agent runtime state.

## 5. Provider 整改方案

### 5.1 WeChat iLink

Current problem:

- `get_bot_qrcode` and `get_qrcode_status` are called by cloud daemon.
- `loginId -> botToken` is in cloud daemon memory.
- Long-term `getupdates` should be in `gateway-ingress`, but credential ownership is not there.

Target flow:

```text
frontend -> Hub -> gateway-ingress: login/start
gateway-ingress -> iLink: get_bot_qrcode
gateway-ingress: create temporary login session
frontend displays qrcode

frontend -> Hub -> gateway-ingress: login/status(loginId)
gateway-ingress -> iLink: get_qrcode_status
gateway-ingress: store botToken in temporary setup session after confirmed

user sends one WeChat message
frontend -> Hub -> gateway-ingress: discover(loginId)
gateway-ingress -> iLink: getupdates using temporary botToken
gateway-ingress: return sender candidates, not botToken

frontend -> Hub -> gateway-ingress: create gateway(loginId, allowedSenderIds)
gateway-ingress: persist secret, cursor, config; start provider adapter
Hub: mirror metadata for dashboard
```

State ownership:

```text
temporary login session: gateway-ingress memory or durable short-TTL setup table
botToken: gateway-ingress secret store
get_updates_buf/cursor: gateway-ingress provider state
allowedSenderIds: gateway-ingress config, optionally mirrored in Hub
context_token/trace for replies: gateway-ingress inbound/outbound state
```

Required behavior:

- Expired setup sessions return a distinct `login_expired` or `login_missing` code.
- Do not reuse cloud daemon `LoginSessionStore` for Cloud Agent WeChat.
- Do not start a WeChat provider channel inside cloud daemon for cloud gateways.
- On gateway delete/disable, stop `gateway-ingress` provider adapter and delete/revoke secret.

### 5.2 Feishu / Lark

Current problem:

- Current daemon-side scan/registration can produce `appId/appSecret`.
- A paused cloud daemon cannot keep Feishu event subscription or webhook consumer active.
- Feishu is push/event-oriented, so the always-on observer must be `gateway-ingress`.

Target flow:

```text
frontend -> Hub -> gateway-ingress: feishu/login/start(domain)
gateway-ingress -> Feishu/Lark: start PersonalAgent registration
gateway-ingress: create temporary setup session with deviceCode/verification URL
frontend displays verification URL / QR

frontend -> Hub -> gateway-ingress: feishu/login/status(loginId)
gateway-ingress -> Feishu/Lark: poll registration
gateway-ingress: store appId/appSecret/userOpenId in temporary setup session

frontend -> Hub -> gateway-ingress: create gateway(loginId, allowedSenderIds, allowedChatIds)
gateway-ingress: persist appSecret, appId, domain, userOpenId, event subscription state
Hub: mirror public metadata
```

State ownership:

```text
temporary registration session: gateway-ingress
appSecret: gateway-ingress secret store
appId/domain/userOpenId: gateway-ingress config, safe metadata mirrored to Hub
event subscription/webhook cursor: gateway-ingress provider state
allowedSenderIds/allowedChatIds: gateway-ingress config, optionally mirrored in Hub
```

Ingress modes:

- MVP: Feishu/Lark event WebSocket managed by `gateway-ingress`.
- Later: webhook if deployment has public callback endpoint and durable ACK semantics.

Required behavior:

- `gateway-ingress` must be the only event subscriber for Cloud Agent Feishu gateways.
- cloud daemon must not hold Feishu `appSecret` for cloud gateways.
- `userOpenId` discovered during registration can default into `allowedSenderIds`, but user can edit before save.

### 5.3 Telegram

Current problem:

- Telegram local daemon flow expects frontend/user to provide bot token and then daemon owns polling.
- For Cloud Agent, polling must be always-on in `gateway-ingress`.

Target flow:

```text
frontend -> Hub -> gateway-ingress: telegram/validate
gateway-ingress -> Telegram: getMe using supplied botToken
gateway-ingress: create temporary token session or validate inline

user sends one Telegram message to bot / group / channel
frontend -> Hub -> gateway-ingress: telegram/discover(loginId or token session)
gateway-ingress -> Telegram: getUpdates
gateway-ingress: return chat/sender candidates

frontend -> Hub -> gateway-ingress: create gateway(token session, allowedChatIds, allowedSenderIds)
gateway-ingress: persist botToken and update offset/provider state
Hub: mirror metadata
```

State ownership:

```text
botToken: gateway-ingress secret store
getUpdates offset: gateway-ingress provider state
allowedChatIds/allowedSenderIds: gateway-ingress config, optionally mirrored in Hub
temporary token validation session: gateway-ingress short-TTL setup state
```

Security note:

- Frontend may submit Telegram `botToken` to Hub BFF, but Hub should forward it to `gateway-ingress` and avoid persistence/logging.
- For stricter separation, add a direct browser-to-ingress signed upload URL later; not required for MVP if Hub redaction is enforced.

Required behavior:

- Do not let cloud daemon poll Telegram for cloud gateways.
- Telegram `getUpdates` offset for a bot token must have one owner. For Cloud Agent gateways, that owner is `gateway-ingress`.
- If a bot token is already owned by another active cloud gateway, reject or require explicit transfer to avoid offset contention.

## 6. Data Model

`gateway-ingress` is source of truth for Cloud Agent third-party provider runtime state.

### 6.1 ingress_gateway_connections

```text
id
agent_id
user_id
provider                  telegram | wechat | feishu
label
status                    pending | active | disabled | error
enabled
config_json               allowlists, splitAt, domain, safe provider metadata
secret_ref
created_at
updated_at
```

### 6.2 ingress_gateway_setup_sessions

```text
login_id
agent_id
user_id
provider
status                    pending | scanned | confirmed | expired | failed
public_payload_json        qrcodeUrl, verificationUrl, qrcode text, appId preview
secret_payload_ref         temporary provider token/appSecret/botToken
expires_at
created_at
updated_at
```

Notes:

- This can be in-memory for a single-instance ingress MVP, but durable short-TTL storage is preferred to survive deploy restarts.
- Secrets in setup sessions must use the same redacted secret store path as long-term credentials.

### 6.3 ingress_gateway_provider_state

```text
gateway_id
cursor_json
dedupe_json
last_poll_at
last_inbound_at
last_error
updated_at
```

### 6.4 ingress_gateway_inbound_events

Same as `cloud-gateway-ingress-technical-design.md`: durable inbound queue with provider event id, normalized message, delivery status, attempt count and last error.

### 6.5 Hub mirror

Hub may keep `agent_gateway_connections` as dashboard mirror:

```text
id
agent_id
user_id
provider
label
status
enabled
config_json               no provider secret
last_error
updated_at
```

For Cloud Agent rows, Hub mirror is not the provider runtime source of truth. Updates should be driven by `gateway-ingress` create/patch/delete responses or sync events.

## 7. Runtime Wake Flow After Pause

When a Cloud Agent is paused and a third-party message arrives:

```text
1. gateway-ingress provider adapter receives or polls the event.
2. gateway-ingress validates gateway enabled/status and allowlists.
3. gateway-ingress writes inbound event durably.
4. gateway-ingress calls Hub ensure-running.
5. Hub resumes the cloud daemon sandbox via CloudAgentService.
6. Hub waits for cloud daemon control WS or reports provisioning.
7. gateway-ingress receives runtime endpoint/token.
8. gateway-ingress opens/reuses runtime WS.
9. gateway-ingress sends gateway_inbound frame.
10. cloud daemon dispatcher runs the turn.
11. cloud daemon sends outbound frames back to gateway-ingress.
12. gateway-ingress sends provider reply and marks delivery.
```

No step depends on cloud daemon observing the original third-party message.

## 8. Failure Semantics

Setup failures:

- `login_missing`: login id is unknown to `gateway-ingress`.
- `login_expired`: setup session existed but passed `expires_at`.
- `login_unconfirmed`: provider login not confirmed yet.
- `provider_unreachable`: provider API failed.
- `provider_auth_failed`: submitted credential is invalid.
- `gateway_conflict`: credential/cursor is already owned by another active gateway.

Runtime delivery failures:

- If `ensure-running` returns `provisioning`, keep event queued and retry.
- If resume fails transiently, keep event queued with backoff.
- If provider cursor cannot advance safely, leave provider adapter state unchanged.
- If runtime WS drops during delivery, return event to queued unless max attempts exceeded.
- If provider send fails after runtime result, mark outbound delivery failed and keep inbound event status with enough context for retry/manual inspection.

## 9. Migration Plan

### Phase 0: Stop making the bug worse

- For Cloud Agent gateway setup, add explicit logs for target host and setup owner:
  - `agent_id`
  - `provider`
  - `login_id`
  - `hosting_kind`
  - `daemon_instance_id`
  - `cloud_daemon_instance_id`
  - `setup_owner = daemon | gateway-ingress`
- Split daemon errors into `login_missing` vs `login_expired` to diagnose current failures.
- Keep local daemon behavior unchanged.

### Phase 1: gateway-ingress setup API

- Add setup session store and provider secret store support in `gateway-ingress`.
- Implement WeChat login start/status/discover/create in `gateway-ingress`.
- Implement Telegram validate/discover/create in `gateway-ingress`.
- Implement Feishu login start/status/create in `gateway-ingress`.
- Add provider-agnostic create/patch/delete/test APIs.

### Phase 2: Hub route split

- Change Hub gateway routes:
  - local daemon agents continue using daemon control frames;
  - cloud agents proxy setup/config operations to `gateway-ingress`.
- Add Hub mirror update logic for cloud gateway rows.
- Ensure Hub logs redact Telegram bot token, WeChat bot token, Feishu app secret.

### Phase 3: Runtime ingress ownership

- Ensure cloud gateway provider adapters run only in `gateway-ingress`.
- Disable cloud daemon provider channel creation for cloud-hosted third-party gateway configs.
- Wire `gateway-ingress` provider adapters to durable inbound queue and Hub `ensure-running`.
- Wire outbound runtime frames to provider senders.

### Phase 4: Cutover and cleanup

- Migrate existing Cloud Agent gateway secrets from cloud daemon secret files, if any, into `gateway-ingress` secret store.
- Delete or ignore stale cloud daemon third-party secret files after migration succeeds.
- Add dashboard copy that Cloud Agent gateway setup is managed by cloud ingress, while local daemon setup is managed by local daemon.
- Add operational runbook for rotating ingress service secret and provider credentials.

## 10. Tests

Backend / Hub:

- Cloud Agent WeChat login start proxies to `gateway-ingress`, not cloud daemon.
- Local daemon WeChat login start still dispatches control frame to daemon.
- Cloud Agent create gateway never persists raw provider secret in Hub DB.
- Hub mirror updates after gateway-ingress create/patch/delete.
- Cloud gateway ensure-running resumes paused agent and returns runtime metadata.

gateway-ingress:

- WeChat login session survives provider status/discover within TTL.
- WeChat expired vs missing session returns distinct codes.
- WeChat confirmed login creates secret ref and starts polling adapter.
- Telegram validate rejects invalid bot token and never logs token.
- Telegram getUpdates offset is advanced only after durable inbound event write.
- Feishu registration stores `appSecret` only in ingress secret store.
- Feishu event dedupe prevents duplicate runtime deliveries.
- Runtime delivery queues event when Hub reports `provisioning`, then retries.
- Runtime outbound frame sends provider reply and marks delivery.

Daemon:

- Cloud daemon does not start third-party provider adapters for cloud-owned gateway configs.
- Cloud daemon accepts `gateway_inbound` runtime frames without provider secrets.
- Local daemon provider setup remains unchanged.

End-to-end:

- Paused Cloud Agent receives Telegram message and resumes.
- Paused Cloud Agent receives WeChat message and resumes.
- Paused Cloud Agent receives Feishu event and resumes.
- Gateway setup still works if cloud daemon is paused, because setup is handled by `gateway-ingress`.
- Restarting cloud daemon during setup no longer invalidates `loginId`.
- Restarting `gateway-ingress` during setup either preserves durable setup session or returns `login_missing` with a clear rescan path.

## 11. Rollout Risks

- Telegram bot tokens cannot safely be polled by two owners; migration must prevent local/cloud duplicate ownership.
- Feishu event subscription/webhook configuration may require provider-side callback changes.
- WeChat iLink cursor/context token behavior must be validated under ingress restart.
- `gateway-ingress` becomes security-critical because it owns provider secrets.
- Durable setup sessions improve UX but increase secret lifecycle surface; TTL and cleanup jobs are mandatory.

## 12. Acceptance Criteria

The remediation is complete when:

- Cloud Agent WeChat/Feishu/Telegram setup does not dispatch provider login/start/status/discover to cloud daemon.
- Cloud Agent provider credentials are stored only in `gateway-ingress` secret store.
- A paused Cloud Agent can be resumed by an inbound Telegram, WeChat, or Feishu message.
- Deleting/disabling a Cloud Agent gateway stops the corresponding `gateway-ingress` adapter.
- Hub stores only safe metadata/mirror fields for Cloud Agent gateways.
- Local daemon gateway setup and runtime behavior remain backward compatible.
- The user-visible `login session not found or expired` during sub-minute Cloud Agent setup is eliminated, except when the ingress setup session is truly missing/expired and the UI gives a clear rescan path.
