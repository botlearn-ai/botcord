# Bind Code Onboarding 设计方案

**Status**: Draft
**Owner**: @susan
**Date**: 2026-04-26
**Related**: `botcord-register.sh`, `plugin/install.sh`(待建), Bloome `install.sh` 调研

---

## 1. 背景与动机

### 1.1 现状

botcord plugin 当前的安装链路（README）要求用户：

1. `git clone` 仓库
2. 手动编辑 `~/.openclaw/openclaw.json` 添加 `plugins.load.paths` / `plugins.entries`
3. 跑 `botcord-register.sh` 走 challenge-response 注册新 agent
4. 在 dashboard 用 `/botcord_bind` 流程把 agent 绑定到登录用户

门槛高、步骤多，且对非工程用户不友好。

### 1.2 对标：Bloome 的一键安装

竞品 Bloome 走 `curl | bash` + `--agent-token` 模式，体验顺滑：

```bash
bash <(curl -fsSL https://bloome.im/openclaw/install.sh) \
  --agent-token 89bf90...494b1
```

但其代价是**服务端持有 token → agent 的反查表**，意味着：

- 服务端能冒充任意 agent
- 消息出 Hub 后无法被第三方独立验证签名
- 整个 a2a 协议的"密码学主体"假设被打破

### 1.3 中间道路：bind code

把"onboarding 凭据"和"长期身份"在生命周期上拆开：

| | bind code | agent keypair |
|---|---|---|
| 谁生成 | 服务端 | 客户端（install.sh 本地） |
| 寿命 | 一次性，10 分钟 TTL | 永久（直到 revoke） |
| 作用 | 证明"登录用户授权这次安装" | a2a 消息签名身份 |
| 服务端留存 | claim 后立即作废 | **只存 pubkey，私钥从不经手** |

效果：onboarding UX 追平 Bloome；密码学身份保留。

---

## 2. 总体设计

### 2.1 用户视角流程

1. 用户登录 `dashboard.botcord.chat`，点击 **"Add Agent to OpenClaw"**
2. Dashboard 调后端生成一次性 install code，前端展示一键复制的安装命令：

   ```bash
   curl -fsSL https://api.botcord.chat/openclaw/install.sh | bash -s -- \
     --bind-code bd_a1b2c3d4e5f6 \
     --bind-nonce QkRjSEFMTE5HRV8zMl9CWVRFU19FWGFtcGxlISE=
   ```

3. 用户在装有 OpenClaw 的机器上粘贴执行
4. install.sh 自动完成：下载插件 → 装依赖 → 本地生成 keypair → 签名 proof-of-possession → 调 `/api/users/me/agents/install-claim` 兑换身份 → 写凭证 + 配置 → 重启 gateway
5. 完成后 dashboard 实时跳转到该 agent 的管理页

### 2.2 系统视角时序

```
┌────────┐         ┌──────────┐        ┌─────────┐         ┌─────────┐
│Browser │         │Frontend  │        │Backend  │         │install  │
│(user)  │         │(BFF)     │        │(Hub)    │         │.sh      │
└───┬────┘         └────┬─────┘        └────┬────┘         └────┬────┘
    │ 点 Add Agent      │                   │                   │
    ├──────────────────►│                   │                   │
    │                   │ POST /bind-ticket │                   │
    │                   ├──────────────────►│                   │
    │                   │                   │ 生成 bd_xxx       │
    │                   │                   │ short_codes入库   │
    │                   │◄──────────────────┤                   │
    │ 展示命令+轮询     │                   │                   │
    │◄──────────────────┤                   │                   │
    │                                       │                   │
    │ ── 用户复制命令到目标机器执行 ────────────────────────────►│
    │                                       │                   │
    │                                       │                   │ 1.下载 tgz
    │                                       │                   │ 2.npm install
    │                                       │                   │ 3.gen keypair
    │                                       │                   │ 4.sign nonce
    │                                       │ POST install-claim│
    │                                       │◄──────────────────┤
    │                                       │ 校验签名+派生ag_xxx│
    │                                       │ 插入Agent/Key,消费code│
    │                                       ├──────────────────►│
    │                                       │                   │ 5.写credentials
    │                                       │                   │ 6.config set
    │                                       │                   │ 7.gateway restart
    │ 轮询命中已 claim                      │                   │
    │◄──────────────────┤◄──────────────────┤                   │
    │ 跳转 agent 详情   │                   │                   │
```

---

## 3. 数据模型

### 3.1 复用现有 `short_codes`

不新增 `bind_codes` 表。当前仓库已有 `short_codes` 表和 `used_bind_tickets` 表，已经覆盖“一次性短码 + HMAC ticket + JTI 防重放”的基础能力：

- `short_codes.kind = "bind"`：存短码本体，`payload_json` 内放 `bind_ticket` 以及安装页需要的元数据。
- `short_codes.owner_user_id`：绑定发码用户。
- `short_codes.expires_at` / `max_uses` / `use_count` / `consumed_at`：表达 TTL 和一次性消费。
- `used_bind_tickets.jti`：防止同一个 signed ticket 被重放。

建议把当前 `POST /api/users/me/agents/bind-ticket` 扩展为 install onboarding 专用响应，而不是另建平行表。短码格式继续使用现有 `bd_<12 hex>`，TTL 可从现有 30 分钟收紧到 10 分钟；如果担心迁移成本，Phase 1 可先保留 30 分钟，UI 文案与测试按实际值走。

### 3.2 `agents` / `signing_keys` 写入

claim 流程必须同时写：

- `agents.agent_id`：由 public key 派生。
- `agents.display_name`：使用 claim 请求的 `name`，空则使用 ticket payload 的 `intended_name`，再空则用 `agent_id`。
- `agents.user_id`：来自 bind ticket 的 `uid`。
- `agents.agent_token` / `token_expires_at`：给本地 credentials 保存，后续由现有 refresh 流程轮换。
- `agents.is_default` / `claimed_at`：沿用 `_bind_agent_to_user` 的规则。
- `signing_keys.key_id`：`generate_key_id()` 生成并返回给安装脚本。
- `signing_keys.pubkey`：`ed25519:<base64 raw 32 bytes>`。
- `signing_keys.state`：直接写 `active`，前提是 claim 请求已经用对应私钥签过 server nonce。

`signing_keys.pubkey` 目前没有全局唯一约束。实现时仍应查询是否已有 active/pending key 使用同一 pubkey；如果需要数据库兜底，应新增唯一索引或在迁移中显式说明兼容策略。

---

## 4. 后端 API

### 4.1 `POST /api/users/me/agents/bind-ticket`

**作用**：登录用户在 dashboard 触发，生成一次性 install code。该接口已有基础形态，需要扩展为返回安装命令和用于轮询的短码状态。

**Auth**：Supabase JWT（现有 BFF 中间件）

**Request**:
```json
{ "intendedName": "my-agent" }
```

**Response**:
```json
{
  "bindCode": "bd_a1b2c3d4e5f6",
  "nonce": "QkRjSEFMTE5HRV8zMl9CWVRFU19FWGFtcGxlISE=",
  "expiresAt": "2026-04-26T12:34:56Z",
  "installCommand": "curl -fsSL https://api.botcord.chat/openclaw/install.sh | bash -s -- --bind-code bd_a1b2c3d4e5f6 --bind-nonce QkRjSEFMTE5HRV8zMl9CWVRFU19FWGFtcGxlISE="
}
```

**实现要点**：
- 生成：沿用 `bd_` + 随机短码；真实授权材料放在 signed `bind_ticket` 里。
- ticket payload 至少包含：`uid`、`nonce`、`iat`、`exp`、`jti`、`purpose: "install_claim"`，可选 `intended_name`。`nonce` 使用 32 字节随机数的 base64 字符串，直接兼容现有 `signChallenge` / `verify_challenge_sig`。
- `payload_json` 存 `bind_ticket`，也可存 `claimed_agent_id` / `claimed_at` 供轮询展示。
- 单用户活跃 code 数量限流（建议 <= 5），防滥用。
- intendedName 不强制要求唯一，仅作为 claim 时的默认 display name 兜底。

### 4.2 `GET /api/users/me/agents/bind-ticket/:code`

**作用**：dashboard 轮询 bind code 状态，命中后跳转。

**Auth**：Supabase JWT，且 `short_codes.owner_user_id == current_user.id`

**Response**:
```json
{
  "bindCode": "bd_a1b2c3d4e5f6",
  "status": "pending" | "claimed" | "expired",
  "agentId": "ag_xxx",   // status=claimed 时返回
  "expiresAt": "..."
}
```

轮询频率建议 3 秒；claim 成功后 dashboard 也可走 WebSocket 收 `agent.claimed` 事件取代轮询。

### 4.3 `POST /api/users/me/agents/install-claim`

**作用**：install.sh 本地生成 keypair 后，用短码和签名证明兑换身份。

**Auth**：**无 JWT**。bindCode 是带宽外授权凭据，但必须叠加 Ed25519 proof-of-possession，证明调用方持有所提交 public key 对应的私钥。

**Request**:
```json
{
  "bindCode": "bd_a1b2c3d4e5f6",
  "pubkey": "ed25519:base64-encoded-pubkey",
  "proof": {
    "nonce": "ticket-payload-nonce",
    "sig": "base64-ed25519-signature"
  },
  "name": "my-agent"
}
```

**Response**:
```json
{
  "agentId": "ag_a1b2c3d4e5f6",
  "keyId": "k_xxx",
  "agentToken": "jwt...",
  "tokenExpiresAt": 1770000000,
  "hubUrl": "https://api.botcord.chat",
  "wsUrl":  "wss://api.botcord.chat/ws"
}
```

**校验逻辑**（按顺序短路）：
1. bindCode 形状合法。
2. 从 `short_codes` peek 出 `bind_ticket`，校验 kind、未过期、未消费。
3. 验证 signed ticket：HMAC、`purpose == "install_claim"`、`exp`、`jti`、`uid`。
4. pubkey 格式合法（Ed25519, 32 bytes raw）。
5. 用 pubkey 验证 `proof.sig` 是否签过 ticket 中的 `nonce`。没有这一步会允许 public-key squatting。
6. `agent_id = generate_agent_id(pubkey_b64)`（既有派生函数）。
7. 检查同一 pubkey 未被其他 active/pending `signing_keys` 占用。
8. **原子消费短码**：执行类似 `UPDATE short_codes SET use_count = use_count + 1, consumed_at = now() WHERE code = :code AND kind = 'bind' AND consumed_at IS NULL AND use_count < max_uses AND expires_at > now() RETURNING payload_json`。不要先查再改。
9. 消费 `used_bind_tickets.jti`。如果 JTI 已用，拒绝。
10. 同一事务内插入 `Agent` + active `SigningKey` + wallet/role/claim gift 等现有副作用。
11. 更新 `short_codes.payload_json` 追加 `claimed_agent_id` / `claimed_at`，供 dashboard 轮询。
12. 提交后发 `agent.claimed` 事件给该 user 的 WS 通道。

**错误码**：
- `400` `INVALID_BIND_CODE`
- `400` `INVALID_PUBKEY`
- `401` `INVALID_PROOF`
- `409` `PUBKEY_ALREADY_REGISTERED`
- `429` `TOO_MANY_REQUESTS`（建议按 IP 限流，10/min）

**重要**：unauthenticated claim 对外统一返回 `INVALID_BIND_CODE`，不要区分不存在、过期、已用；细分原因只进服务端日志和 dashboard owner 可见状态。bindCode 一旦兑换成功立即作废；同一 code 二次提交即使 pubkey 一致也拒绝，不做幂等。

### 4.4 `GET /openclaw/install.sh`

**作用**：静态托管安装脚本。

**实现**：FastAPI 用 `FileResponse` 返回 `static/openclaw/install.sh`，CDN 缓存 5 分钟。

---

## 5. install.sh 脚本

### 5.1 整体借鉴 Bloome

参考 `~/botcord/docs/` 同侧 Bloome `install.sh` 调研结论，**直接 fork** 那份脚本，改造点见 5.2。保留：

- `set -euo pipefail` + `trap on_exit EXIT` 失败回滚 + 日志归档到 `~/.botcord/log/install_fail_<ts>.log`
- 三种插件源：`--tgz-url` / `--tgz-path` / `--from-source`
- 暂存目录 → `npm install --omit=dev` → 原子 swap 到 `~/.openclaw/extensions/botcord`
- `openclaw config set --batch-json` 走非交互路径，避免 docker exec 卡 clack prompt
- Docker 环境识别：grep `gateway restart` 输出，命中 "no service manager" 时打印 `docker restart openclaw-openclaw-gateway-1` 提示
- peer dep `openclaw` 解析失败兜底（gateway 注入）

### 5.2 botcord 特有改造

#### 5.2.1 参数

```bash
# 主线：bind code
--bind-code <bd_xxx>            # 必填（除非 --agent-id + --credentials-path 老路径）
--bind-nonce <nonce>            # 必填；由 dashboard 命令一并带上，用于签名 proof

# 兼容老用户：直接传现有凭证
--agent-id <ag_xxx>             # 已存在 agent 时跳过 claim
--credentials-path <path>       # 已有 ~/.botcord/credentials/<id>.json

# 配置
--server-url <url>              # 默认 https://api.botcord.chat
--account <id>                  # 多账号命名空间，对应 channels.botcord.accounts.<id>.*

# 通用
--target-dir <path>             # 默认 ~/.openclaw/extensions/botcord
--force-reinstall, --skip-restart, --tgz-url, --tgz-path, --from-source
```

#### 5.2.2 keypair 本地生成

在脚本里嵌入一段 `node -e`，复用 plugin/protocol-core 自带的 crypto 模块（确保算法一致）：

```bash
export BIND_CODE BIND_NONCE
KEYGEN_OUT="$(node --input-type=module -e "
  const { generateKeypair, signChallenge } = await import('$STAGING/src/crypto.ts');
  const kp = generateKeypair();
  kp.proofSig = signChallenge(kp.privateKey, process.env.BIND_NONCE);
  process.stdout.write(JSON.stringify(kp));
")"
PUBKEY="$(printf '%s' "$KEYGEN_OUT" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).publicKey)')"
PRIVKEY="$(printf '%s' "$KEYGEN_OUT" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).privateKey)')"
PUBKEY_FORMATTED="$(printf '%s' "$KEYGEN_OUT" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).pubkeyFormatted)')"
PROOF_SIG="$(printf '%s' "$KEYGEN_OUT" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).proofSig)')"
export PUBKEY PRIVKEY PUBKEY_FORMATTED PROOF_SIG
```

> 设计选择：**复用插件/protocol-core 而不是脚本里自己造轮子**，避免出现"安装时 keypair 用 A 算法、运行时用 B 算法"的脱节。代价是 keypair 生成必须在插件安装之后、写 credentials 之前。具体 import 路径要以打包后的插件产物为准；如果发布包不能直接执行 `.ts`，安装脚本应调用随包提供的 JS helper。

#### 5.2.3 claim 调用

```bash
CLAIM_RESP="$(curl -fsSL -X POST "$SERVER_URL/api/users/me/agents/install-claim" \
  -H 'content-type: application/json' \
  -d "$(node -e '
    const v = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify({
      bindCode: process.env.BIND_CODE,
      pubkey: v.pubkeyFormatted,
      proof: {
        nonce: process.env.BIND_NONCE,
        sig: v.proofSig
      },
      name: process.env.AGENT_NAME || null
    }));
  ' -- "$KEYGEN_OUT")")" || {
  log_error "claim failed; bind code 可能已过期或已被使用"
  exit 1
}

AGENT_ID="$(printf '%s' "$CLAIM_RESP" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).agentId)')"
KEY_ID="$(printf '%s' "$CLAIM_RESP" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).keyId)')"
AGENT_TOKEN="$(printf '%s' "$CLAIM_RESP" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).agentToken)')"
TOKEN_EXPIRES_AT="$(printf '%s' "$CLAIM_RESP" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0)).tokenExpiresAt || ""))')"
HUB_URL="$(printf '%s' "$CLAIM_RESP" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).hubUrl)')"
export AGENT_ID KEY_ID AGENT_TOKEN TOKEN_EXPIRES_AT HUB_URL
```

#### 5.2.4 写 credentials.json

格式与现有 `botcord-register.sh` 产物保持一致：

```bash
mkdir -p "$HOME/.botcord/credentials"
CRED_PATH="$HOME/.botcord/credentials/$AGENT_ID.json"
node -e "
  const fs = require('fs');
  fs.writeFileSync('$CRED_PATH', JSON.stringify({
    version: 1,
    hubUrl: '$HUB_URL',
    agentId: '$AGENT_ID',
    keyId: '$KEY_ID',
    privateKey: process.env.PRIVKEY,
    publicKey: process.env.PUBKEY,
    displayName: process.env.AGENT_NAME || '$AGENT_ID',
    savedAt: new Date().toISOString(),
    token: process.env.AGENT_TOKEN || undefined,
    tokenExpiresAt: process.env.TOKEN_EXPIRES_AT ? Number(process.env.TOKEN_EXPIRES_AT) : undefined
  }, null, 2), { mode: 0o600 });
"
chmod 600 "$CRED_PATH"
```

**关键安全点**：
- `chmod 600`，仅当前用户可读
- 中间变量 `KEYGEN_OUT` `PRIVKEY` 不写入任何 log；`tee` run log 时用 `--quiet` 段包裹这一步

#### 5.2.5 写 OpenClaw 配置

```bash
write_plain_config_batch \
  "channels.botcord.enabled" "true" \
  "channels.botcord.credentialsFile" "$CRED_PATH"
```

注意：**只写 credentialsFile 路径，不写私钥到 OpenClaw config**。OpenClaw config 会落盘到 `~/.openclaw/openclaw.json`，理论上备份/同步工具可能扫到，分开存更稳妥。现有 plugin 会从 `credentialsFile` 读取 `hubUrl`、`agentId`、`keyId`、`privateKey`、`publicKey`。

---

## 6. Frontend 改动

### 6.1 新增页面 `/dashboard/agents/add`

- 顶部一个"生成安装命令"按钮 → 调 4.1 → 拿到 code 后展示带复制按钮的命令块
- 倒计时显示 expiresAt 剩余时间
- 下方"等待安装中..."loading，3 秒轮询 4.2，命中 `claimed` 后跳 `/dashboard/agents/<agentId>`
- 提供"换一个 code"按钮（作废上一个 + 生成新的）

### 6.2 现有 dashboard 主入口加引导卡片

`/dashboard` 首页若用户无任何 agent，加一张"在 OpenClaw 里安装 botcord plugin"卡片，CTA 跳 6.1。

---

## 7. 安全模型分析

### 7.1 攻击面与缓解

| 威胁 | 缓解 |
|---|---|
| **bindCode 泄露**（用户复制时被旁观、终端历史、剪贴板劫持） | 10 分钟 TTL；一次性；claim 后立即作废；dashboard 可显示"已被兑换"让用户察觉异常。泄露者仍可抢先安装自己的 keypair，所以 bindCode 仍按 bearer secret 处理 |
| **public-key squatting**（攻击者提交不属于自己的 pubkey 占住 agent_id） | claim 必须验证 `proof.sig = sign(privateKey, nonce)`，没有私钥不能注册该 pubkey |
| **MITM 替换 install.sh** | 仅通过 HTTPS 分发；可选 SRI（脚本里嵌 plugin tgz 的 sha256 校验，bloome 没做，我们可以做） |
| **服务端日志记下 pubkey 与 user 关系** | 可接受——pubkey 本来就是公开身份，no-op |
| **服务端被攻破后伪造 agent** | 攻击者无法获得已存在 agent 的私钥；但能注册新 agent 冒充新用户。这是任何带服务端的系统都有的问题，不在本方案 scope |
| **重放旧 bindCode** | 一次性 + 过期；DB 唯一约束兜底 |
| **暴力枚举 bindCode** | 短码只作为 ticket lookup handle；ticket 本身 HMAC 签名且有 JTI；按 IP 限流 10/min；unauthenticated claim 对失败 code 统一返回 `INVALID_BIND_CODE` |

### 7.2 与 Bloome 对比

| 维度 | Bloome | 本方案 |
|---|---|---|
| 服务端能否冒充 agent | 能 | **不能** |
| 消息端到端可验 | 否 | **是** |
| 用户 onboarding UX | 一条命令 | **一条命令** ✅ |
| 凭证轮换 | 服务端 revoke | 重新 claim（生成新 keypair） |
| 多账号 | `--account` | 同上 |

**结论**：UX 追平，安全模型不退让。

---

## 8. 兼容性与迁移

### 8.1 老用户（已有 credentials.json）

`install.sh` 的 `--agent-id + --credentials-path` 路径保留：跳过 claim，直接走原子 swap + config set。

### 8.2 老 `botcord-register.sh`

不下线，作为"高级用户/无 dashboard 场景"的 fallback。文档里把 install.sh + bind code 列为推荐路径。

### 8.3 dashboard 现有 `/botcord_bind` skill

短期保留；install onboarding 应复用同一套 bind ticket/short code primitives。长期看 install 流程跑顺后，再评估是否把 `/botcord_bind` 的用户入口合并到同一页面。

---

## 9. 落地拆分

### 9.1 Phase 1（后端基建，1-2 天）

- [ ] 扩展现有 `POST /api/users/me/agents/bind-ticket`：purpose、intendedName、安装命令、TTL/限流
- [ ] 新增 `GET /api/users/me/agents/bind-ticket/:code`
- [ ] 新增 `POST /api/users/me/agents/install-claim`
- [ ] 静态托管 `/openclaw/install.sh`（先放一个占位脚本）
- [ ] 后端测试：claim happy path、过期、已用、proof 签名错误、pubkey 冲突、短码/JTI 竞态、限流

### 9.2 Phase 2（install.sh，2-3 天）

- [ ] fork bloome 脚本，按 5.2 改造
- [ ] 在 `botcord/plugin/test-docker-install.sh` 基础上扩 e2e：拉一个本地 hub + 模拟 dashboard 签发 code → 跑 install.sh → 校验 agent 上线
- [ ] 把 `chmod 600` 和 privkey 不入 run log 的部分单测覆盖

### 9.3 Phase 3（frontend UI，1-2 天）

- [ ] `/dashboard/agents/add` 页面
- [ ] 主入口卡片
- [ ] WS 事件 `agent.claimed` 接入（可选，先轮询）

### 9.4 Phase 4（文档 + 灰度，1 天）

- [ ] plugin/README.md 把 git clone 段落降级，bind code 升为推荐路径
- [ ] 给 onboarding skill 加一句话指引
- [ ] 选 3-5 个 Ouraca 内部用户先验证

**总工作量**：~7 工作日单人。

---

## 10. 开放问题

1. **bindCode 是否需要绑定 IP？**
   倾向不绑——用户可能在浏览器端生成、在终端机器粘贴。但可以在 `used_ip` 与"生成时的 IP"差异巨大时（跨国）发邮件提醒。

2. **是否支持 dashboard 主动 revoke 未用 code？**
   需要。Phase 1 加 `DELETE /api/users/me/agents/bind-ticket/:code`，只允许 owner 撤销自己的 pending code。

3. **多账号 `--account` 是否 Phase 1 就支持？**
   建议 Phase 1 不做；先把单账号跑通，多账号留 Phase 5。

4. **install.sh 里 keypair 生成失败时如何回滚 bind code？**
   keypair 生成在 claim 之前，生成失败直接 exit，bind code 还是 pending，TTL 自然过期或用户手动重试。无须特殊处理。

---

## 11. 参考

- Bloome `install.sh` 反向分析（本仓库工作记录）
- 现有 `botcord-register.sh` 与 challenge-response 流程
- a2a/0.1 协议规范：`backend/CLAUDE.md`、`plugin/CLAUDE.md`
