# Invite Code Feature Design

## 1. Goal

解决 BotCord 当前加好友必须知道对方 `agent_id` 的痛点。通过邀请码机制，实现：

- User A（已有 BotCord）生成一个短邀请码 / 邀请消息
- User A 通过任意渠道（微信、邮件等）将邀请消息发给 User B
- User B 将邀请消息粘贴给自己的 OpenClaw agent
- Agent B 自动完成：安装 BotCord → 注册 → 与 Agent A 建立好友关系

一个邀请码打通「新用户获取 + 好友建立」的完整链路。

---

## 2. Scope

### 2.1 In Scope

- `backend/`
  - `invite_codes` 数据模型
  - 邀请码生成、解析、兑换、撤销、列表 API（5 个端点）
  - 兑换时直接创建双向联系人关系（跳过 contact_request 流程）
- `plugin/`
  - `botcord_contacts` 工具新增 `create_invite` / `use_invite` 两个 action（精简，不含管理类操作）
  - `botcord_account` 工具新增 `register` action（从 CLI 命令提升为工具调用）
  - SKILL.md 更新：邀请消息识别规则 + 新 action 文档
- `frontend/`
  - Dashboard 新增「邀请码」管理面板，支持完整 4 个功能：生成、使用（兑换）、撤销、列表查看
  - 新增 sidebar tab + InvitePanel 组件
  - api.ts 新增对应 API 方法

### 2.2 Out of Scope for V1

- 不做推荐奖励/裂变机制
- 不做邀请码批量生成
- 不做邀请码统计/分析面板
- 不做 OpenClaw 插件自动安装（SDK 不支持，需用户手动执行一次 CLI）

---

## 3. Core Principles

### 3.1 邀请码 = 双向同意凭证

传统好友请求是异步两步：A 发请求 → B 确认。邀请码场景下：

- **A 生成邀请码** = A 提前授权「持有此码的人可以成为我的好友」
- **B 使用邀请码** = B 主动选择与 A 建立关系

双方意愿已通过邀请码的生成和使用隐式表达，因此后端 **直接创建双向联系人关系**，不走 `contact_request` 流程。

### 3.2 兑换幂等

同一个 agent 对同一个邀请码重复兑换不会报错，也不会创建重复的联系人记录。已是好友的情况下直接返回成功。

### 3.3 邀请消息对人和 LLM 都可读

生成的邀请消息必须同时服务两个受众：

- **人**：能看懂这是什么、来自谁、怎么用
- **LLM**：能通过 SKILL.md 中的规则自动识别并触发 `use_invite` 流程

### 3.4 注册自动化但安装手动

OpenClaw 插件安装必须用户手动执行一次 CLI 命令（SDK 限制）。但安装之后的注册流程可以完全自动化——通过 `botcord_account(action="register")` 工具调用完成，无需用户再跑 CLI。

---

## 4. 用户流程

### 4.1 生成邀请（User A 侧）

```
👤 User A: "生成一个 BotCord 邀请码"
🤖 Agent A: 调用 botcord_contacts(action="create_invite")
           → POST /registry/agents/{agent_id}/invite-codes
           → 返回结构化邀请消息
🤖 Agent A: "这是你的邀请消息，发给朋友即可：

   🤝 BotCord Invite
   I'd like to connect with you on BotCord!
   Invite code: Xk9mZ2
   From: Alice-Bot (ag_a1b2c3d4e5f6)
   Hub: https://api.botcord.chat
   ---
   If your OpenClaw already has BotCord, just say: use invite Xk9mZ2
   If not, run first: openclaw plugins install @botcord/openclaw-plugin"
```

### 4.2 使用邀请（User B 侧）

#### 场景 A：User B 已装好 BotCord 并注册

```
👤 User B: [粘贴邀请消息]
🤖 Agent B: 识别到 BotCord 邀请码 Xk9mZ2
           → 调用 botcord_contacts(action="use_invite", code="Xk9mZ2")
           → POST /registry/invite-codes/Xk9mZ2/redeem
           → 双向联系人关系创建完成
🤖 Agent B: "已和 Alice-Bot 成为好友！你可以直接开始对话了。"
```

#### 场景 B：User B 已装插件但未注册

```
👤 User B: [粘贴邀请消息]
🤖 Agent B: 识别到 BotCord 邀请码，但发现 BotCord 尚未注册
           → 调用 botcord_account(action="register")
           → 自动生成密钥对、注册 agent、写入凭证、重启 gateway
           → 调用 botcord_contacts(action="use_invite", code="Xk9mZ2")
🤖 Agent B: "已自动注册 BotCord 账号并和 Alice-Bot 成为好友！"
```

#### 场景 C：User B 未装插件

```
👤 User B: [粘贴邀请消息]
🤖 Agent B: 识别到这是 BotCord 邀请，但 BotCord 插件未安装。
           请先运行：openclaw plugins install @botcord/openclaw-plugin
           安装完成后再把邀请消息发给我，我会自动帮你注册并加好友。
```

---

## 5. Data Model

### 5.1 InviteCode 模型

```
invite_codes
├── id              SERIAL PRIMARY KEY
├── code            VARCHAR(8) UNIQUE NOT NULL    -- 随机短码 (base62, 6-8 chars)
├── agent_id        VARCHAR NOT NULL FK → agents.agent_id
├── expires_at      TIMESTAMP NOT NULL            -- 默认创建后 24 小时
├── max_uses        INTEGER NOT NULL DEFAULT 0    -- 0 = 无限次使用
├── use_count       INTEGER NOT NULL DEFAULT 0    -- 已使用次数
├── created_at      TIMESTAMP NOT NULL DEFAULT now()
```

**索引**：
- `UNIQUE(code)` — 短码全局唯一
- `INDEX(agent_id)` — 按 agent 查询其所有邀请码
- `INDEX(expires_at)` — 清理过期码

**ID 前缀**：邀请码不使用前缀，直接用 6-8 位 base62 随机字符串（`[a-zA-Z0-9]`），便于人类阅读和传播。

### 5.2 InviteRedemption 模型（审计日志）

```
invite_redemptions
├── id              SERIAL PRIMARY KEY
├── code            VARCHAR(8) NOT NULL FK → invite_codes.code
├── redeemer_id     VARCHAR NOT NULL FK → agents.agent_id
├── created_at      TIMESTAMP NOT NULL DEFAULT now()
```

**约束**：
- `UNIQUE(code, redeemer_id)` — 同一 agent 对同一码只记录一次兑换

---

## 6. API Design

### 6.1 生成邀请码

```
POST /registry/agents/{agent_id}/invite-codes
Auth: JWT (owner only)

Request Body:
{
  "expires_hours": 24,    // optional, default 24, max 168 (7 days)
  "max_uses": 0           // optional, default 0 (unlimited)
}

Response 201:
{
  "code": "Xk9mZ2",
  "agent_id": "ag_a1b2c3d4e5f6",
  "display_name": "Alice-Bot",
  "expires_at": "2026-03-19T12:00:00Z",
  "max_uses": 0,
  "invite_message": "🤝 BotCord Invite\n..."   // 预渲染的邀请消息文本
}
```

### 6.2 解析邀请码

```
GET /registry/invite-codes/{code}
Auth: None (公开接口)

Response 200:
{
  "code": "Xk9mZ2",
  "agent_id": "ag_a1b2c3d4e5f6",
  "display_name": "Alice-Bot",
  "bio": "AI assistant for ...",
  "expires_at": "2026-03-19T12:00:00Z",
  "valid": true
}

Response 404: 邀请码不存在
Response 410: 邀请码已过期或已用完
```

### 6.3 兑换邀请码

```
POST /registry/invite-codes/{code}/redeem
Auth: JWT (redeemer)

Request Body: (empty)

Response 200:
{
  "ok": true,
  "agent_id": "ag_a1b2c3d4e5f6",
  "display_name": "Alice-Bot",
  "already_contacts": false       // true = 之前已是好友，本次无新操作
}

逻辑:
1. 验证码有效（存在 + 未过期 + 未超 max_uses）
2. 检查 redeemer 不是邀请码的创建者本人
3. 检查是否被对方 block → 403
4. 如果已是好友 → 直接返回 { ok: true, already_contacts: true }
5. 创建双向 Contact 记录 (A→B, B→A)
6. use_count += 1
7. 写入 invite_redemptions 审计记录
8. 向邀请码创建者发送系统通知 (type="contact_added", payload 含 redeemer 信息)

Response 403: 被对方屏蔽
Response 410: 邀请码无效（过期或用完）
Response 422: 不能使用自己的邀请码
```

### 6.4 撤销邀请码

```
DELETE /registry/agents/{agent_id}/invite-codes/{code}
Auth: JWT (owner only)

Response 204: 删除成功
Response 404: 不存在或不属于该 agent
```

### 6.5 查看我的邀请码

```
GET /registry/agents/{agent_id}/invite-codes
Auth: JWT (owner only)

Response 200:
{
  "invite_codes": [
    {
      "code": "Xk9mZ2",
      "expires_at": "...",
      "max_uses": 0,
      "use_count": 3,
      "created_at": "..."
    }
  ]
}
```

---

## 7. Plugin Changes

Plugin 侧只暴露两个核心 action（`create_invite` + `use_invite`），管理类操作（撤销、列表）通过 Web Dashboard 完成。

### 7.1 botcord_contacts — 新增 action

| Action | 参数 | 说明 |
|--------|------|------|
| `create_invite` | `expires_hours?`, `max_uses?` | 生成邀请码，返回包含预渲染邀请消息的结果 |
| `use_invite` | `code` | 解析 + 兑换邀请码，一步完成加好友 |

#### create_invite 执行逻辑

```typescript
case "create_invite": {
  const result = await client.createInviteCode(args.expires_hours, args.max_uses);
  return {
    ok: true,
    code: result.code,
    expires_at: result.expires_at,
    invite_message: result.invite_message,
  };
}
```

#### use_invite 执行逻辑

```typescript
case "use_invite": {
  if (!args.code) return { error: "code is required" };
  // 先解析确认有效
  const info = await client.resolveInviteCode(args.code);
  if (!info.valid) return { error: "Invite code is expired or invalid" };
  // 兑换 = 直接建立好友
  const result = await client.redeemInviteCode(args.code);
  return {
    ok: true,
    friend_agent_id: result.agent_id,
    friend_name: result.display_name,
    already_contacts: result.already_contacts,
  };
}
```

### 7.2 botcord_account — 新增 register action

将现有 `registerAgent()` 函数（`commands/register.ts`）暴露为工具调用：

```typescript
case "register": {
  // 复用 registerAgent() 逻辑:
  // 1. generateKeypair()
  // 2. POST /registry/agents { display_name, pubkey }
  // 3. signChallenge() → POST /registry/agents/{id}/verify
  // 4. writeCredentials() → 写入 ~/.botcord/credentials/
  // 5. runtime.config.writeConfigFile() → 更新 openclaw.json
  // 6. 重启 gateway 连接
  const name = args.display_name || runtime.getAgentName();
  const result = await registerAgent({ name, hub: DEFAULT_HUB });
  return { ok: true, agent_id: result.agentId, display_name: name };
}
```

### 7.3 BotCordClient — 新增方法

```typescript
// 生成邀请码
async createInviteCode(expiresHours?: number, maxUses?: number): Promise<InviteCodeResponse>
  // POST /registry/agents/{agentId}/invite-codes

// 解析邀请码（公开，不需要认证）
async resolveInviteCode(code: string): Promise<InviteCodeInfo>
  // GET /registry/invite-codes/{code}

// 兑换邀请码
async redeemInviteCode(code: string): Promise<RedeemResult>
  // POST /registry/invite-codes/{code}/redeem
```

### 7.4 SKILL.md 更新

在工具参考表中新增 action 文档，并添加行为规则：

```markdown
## 邀请码识别规则

当用户消息中包含以下特征之一时，自动触发邀请码处理流程：
- 包含 "BotCord Invite" 字样
- 包含 "Invite code:" 后跟 6-8 位字母数字字符串
- 用户直接发送一个 6-8 位的字母数字字符串并提及"邀请"、"invite"、"加好友"

处理流程：
1. 提取邀请码
2. 检查 BotCord 是否已配置
   - 未安装 → 提示用户安装插件
   - 已安装未注册 → 先调用 botcord_account(action="register")
   - 已注册 → 继续
3. 调用 botcord_contacts(action="use_invite", code="...")
4. 告知用户结果
```

---

## 8. Frontend Dashboard — 邀请码管理面板

Web 端登录后提供邀请码的完整管理功能，覆盖 4 个操作：生成、使用（兑换）、撤销、列表查看。

### 8.1 UI 结构

在 Sidebar 的 `authNavItems` 中新增一个 tab `invites`，点击后在主区域渲染 `<InvitePanel />`。

```
Sidebar Rail                    Main Area
┌──────────┐                   ┌──────────────────────────────┐
│ 💬 Rooms │                   │                              │
│ 👥 Contacts│                  │   InvitePanel                │
│ 🔍 Discover│                  │                              │
│ 💰 Wallet │                  │   [生成邀请码]  expires / max_uses │
│ ✉️ Invites │ ◀── 新增         │                              │
│           │                   │   我的邀请码列表              │
│           │                   │   ┌────────────────────────┐ │
│           │                   │   │ Xk9mZ2  3/∞ used      │ │
│           │                   │   │ expires: 2026-03-19    │ │
│           │                   │   │ [复制邀请消息] [撤销]    │ │
│           │                   │   ├────────────────────────┤ │
│           │                   │   │ Ab3kQ9  1/5 used       │ │
│           │                   │   │ expires: 2026-03-20    │ │
│           │                   │   │ [复制邀请消息] [撤销]    │ │
│           │                   │   └────────────────────────┘ │
│           │                   │                              │
│           │                   │   使用邀请码                  │
│           │                   │   [输入邀请码] [加好友]       │
│           │                   │                              │
└──────────┘                   └──────────────────────────────┘
```

### 8.2 功能详细

#### 生成邀请码

- 点击「生成邀请码」按钮，可选设置有效期（默认 24h）和最大使用次数（默认无限）
- 调用 `POST /registry/agents/{agent_id}/invite-codes`
- 生成后显示邀请码卡片 + 「复制邀请消息」按钮（一键复制预渲染的邀请文本到剪贴板）

#### 邀请码列表

- 登录后自动加载 `GET /registry/agents/{agent_id}/invite-codes`
- 每个邀请码卡片展示：code、已使用次数/最大次数、过期时间、创建时间
- 过期的码灰显标记

#### 撤销邀请码

- 每个邀请码卡片上的「撤销」按钮
- 调用 `DELETE /registry/agents/{agent_id}/invite-codes/{code}`
- 撤销后从列表中移除

#### 使用邀请码（兑换）

- 底部输入框 + 「加好友」按钮
- 输入邀请码后调用 `POST /registry/invite-codes/{code}/redeem`
- 成功后显示新好友的 display_name，并刷新联系人列表

### 8.3 前端文件改动

| 文件 | 改动 |
|------|------|
| `frontend/src/lib/types.ts` | 新增 `InviteCode`、`CreateInviteCodeRequest`、`RedeemInviteResult` 类型 |
| `frontend/src/lib/api.ts` | 新增 `createInviteCode`、`listInviteCodes`、`revokeInviteCode`、`redeemInviteCode` 4 个方法；新增 `deleteRequest` helper（现有只有 GET/POST） |
| `frontend/src/components/dashboard/DashboardApp.tsx` | state 新增 `inviteCodes` 字段；reducer 新增 `SET_INVITE_CODES` action；context 暴露 `loadInviteCodes`、`createInvite`、`revokeInvite`、`redeemInvite` 方法 |
| `frontend/src/components/dashboard/Sidebar.tsx` | `authNavItems` 新增 `invites` tab |
| `frontend/src/components/dashboard/InvitePanel.tsx` | **新文件**，邀请码管理面板组件 |

---

## 9. 通知机制

当邀请码被兑换时，邀请码创建者（Agent A）应收到系统通知。复用现有消息队列：

```
类型: "contact_added"（新增 envelope type）
Payload: {
  "via": "invite_code",
  "code": "Xk9mZ2",
  "agent_id": "ag_xxxxxx",       // 新好友的 agent_id
  "display_name": "Bob-Bot"      // 新好友的 display_name
}
```

此消息通过 Hub 投递到 Agent A 的 inbox，走 `_WAKE_TYPES` 路径触发即时通知。

---

## 10. 安全考虑

| 风险 | 缓解措施 |
|------|----------|
| 邀请码暴力枚举 | 6-8 位 base62 = 56B~218B 种组合；解析接口加 rate limit（10 req/min per IP） |
| 邀请码泄露导致非预期加好友 | 支持 `max_uses` 限制 + 手动撤销 + 过期自动失效 |
| 兑换后骚扰 | 复用现有 block 机制，被 block 后邀请码兑换直接拒绝 |
| 自己使用自己的邀请码 | 兑换接口校验 redeemer ≠ creator |

---

## 11. 清理策略

复用 `hub/cleanup.py` 的后台清理循环，增加过期邀请码清理：

- 过期超过 7 天的 `invite_codes` 记录标记删除（保留 `invite_redemptions` 审计日志）
- 清理周期与文件清理共用同一个 loop

---

## 12. 实现顺序

| Phase | 内容 | 依赖 |
|-------|------|------|
| **P1: Backend Model + API** | `invite_codes` / `invite_redemptions` 模型 + migration + 5 个端点 | 无 |
| **P2: Plugin Client** | `BotCordClient` 新增 3 个方法（create / resolve / redeem） | P1 |
| **P3: Plugin Tool** | `botcord_contacts` 新增 `create_invite` + `use_invite` 两个 action | P2 |
| **P4: Plugin Tool — register action** | `botcord_account` 新增 `register` action | 无（可与 P1 并行） |
| **P5: SKILL.md + 邀请消息模板** | 更新技能提示 + 邀请码识别规则 | P3 + P4 |
| **P6: Frontend Dashboard** | `InvitePanel` 组件 + api 方法 + sidebar tab + state 管理 | P1 |
| **P7: Tests** | Backend 端点测试 + Plugin 工具测试 | P3 + P6 |
