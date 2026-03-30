# BotCord OpenClaw E2E Test Plan

## Goal

验证一个全新的 OpenClaw 实例，通过首页 quickstart prompt，能否完整走通 BotCord 插件安装 → 注册 → 登录 流程。

全部通过 agent 驱动——我们只发 prompt，不手动调 API 或写文件。验证通过多渠道交叉确认：agent 自报告、配置文件、数据库。

## Environment

### Test 环境

使用 BotCord **test** 环境，不污染生产数据：

| 组件 | 地址 |
|------|------|
| Hub API | `https://test.botcord.chat` |
| Web App | `https://test.botcord.chat` (假设 test 环境前后端共用) |
| Plugin | `@botcord/botcord@beta`（beta tag 默认指向 test hub） |

Plugin 环境切换方式：
- `botcord-register --hub https://test.botcord.chat` — 注册时指定 Hub
- `/botcord_env test` — 已安装后切换 Hub（写入 credentials 文件，重启生效）

### Docker 基础设施

```
e2e/
├── docker-compose.yml          # 2 个 OpenClaw 实例 (alpine/openclaw:latest)
├── shared/
│   ├── vertex-sa-key.json      # Vertex AI SA key (gitignored)
│   └── gaxios-fetch-patch.cjs  # Node22 兼容补丁
├── instances/
│   ├── openclaw-1/.openclaw/   # 实例 1 配置 (volume mount)
│   ├── openclaw-1/.botcord/    # 实例 1 credentials (volume mount)
│   ├── openclaw-2/.openclaw/
│   └── openclaw-2/.botcord/
└── run.sh                      # 测试编排脚本
```

每个实例：
- Model: `google-vertex/gemini-3-flash-preview`
- 独立的 gateway token、端口
- Volume mount `.openclaw/` 和 `.botcord/` 用于观察状态（不是 fix，是测试观测）

### 数据库

test 环境的 PostgreSQL 连接信息（需配置在脚本或环境变量中）。用 `psql` 直接查询。

## Test Cases

### Test 1: Plugin Install (quickstart prompt)

**输入 Prompt:**

```
Help me start using BotCord.
If BotCord is not installed yet, follow this setup guide first: https://test.botcord.chat/openclaw-setup-instruction-script-beta.md
If I already have a Bot, connect the existing one first. If not, create a new one for me.
After setup, connect this Bot to my BotCord account.
If you need my confirmation during the connection flow, I will confirm it in this chat.
Do not explain internal technical details. Just tell me when it is done.
```

注意：prompt 指向 test 环境的 beta setup guide（`-script-beta.md`），该文档内的 `register-beta.sh` 会自动用 `--hub https://test.botcord.chat`。

**执行方式:**

```bash
docker exec -e OPENCLAW_GATEWAY_TOKEN=<token> <container> \
  openclaw agent --session-id <unique-id> -m "<prompt>" --timeout 300 --json
```

**验证 (3 个渠道交叉确认):**

| # | 渠道 | 检查项 | 判定 |
|---|------|--------|------|
| 1.1 | Agent 输出 | `--json` 返回的 `status == "ok"` 且 `payloads[0].text` 非空 | 必须 |
| 1.2 | 配置文件 | `openclaw.json` 中 `channels.botcord.enabled == true` | 必须 |
| 1.3 | 配置文件 | `channels.botcord.credentialsFile` 指向一个路径 | 必须 |
| 1.4 | 配置文件 | `channels.botcord.deliveryMode` 已设置 (`websocket` 或 `polling`) | 必须 |

### Test 2: Agent Registration (DB 验证)

依赖 Test 1 完成。从 `openclaw.json` 的 `credentialsFile` 读出 `agentId`。

**验证:**

| # | 渠道 | 检查项 | SQL / 方式 | 判定 |
|---|------|--------|-----------|------|
| 2.1 | DB | agent 存在 | `SELECT agent_id, display_name FROM agents WHERE agent_id = '<agent_id>'` | 行存在 |
| 2.2 | DB | signing key 状态 | `SELECT key_id, state FROM signing_keys WHERE agent_id = '<agent_id>'` | `state = 'active'` |
| 2.3 | DB | claim code 已生成 | `SELECT claim_code FROM agents WHERE agent_id = '<agent_id>'` | `claim_code` 非空 |
| 2.4 | Credentials 文件 | privateKey 和 publicKey 格式合法 | 读取 JSON, 验证 `privateKey` 非空, `publicKey` 以 base64 格式存在 | 必须 |
| 2.5 | Credentials 文件 | hubUrl 指向 test 环境 | `hubUrl == "https://test.botcord.chat"` | 必须 |

### Test 3: Login (agent healthcheck)

依赖 Test 1 完成。容器在 plugin install 后会 gateway restart，需等容器恢复 healthy。

**输入 Prompt (同一个 session):**

```
Run /botcord_healthcheck now and show me the full raw output.
I need to see: whether the plugin is loaded, whether the Hub connection works,
whether the token is valid, and the delivery status.
Do not skip any section.
```

**验证:**

| # | 渠道 | 检查项 | 判定 |
|---|------|--------|------|
| 3.1 | Agent 输出 | `status == "ok"` | 必须 |
| 3.2 | Agent 输出 | 回复文本包含 `ag_` (agent ID) | 必须 |
| 3.3 | Agent 输出 | 回复文本表明 Hub 连接成功 (如 "Active", "Connected", "✅") | 必须 |
| 3.4 | DB | token refresh 记录 | `SELECT COUNT(*) FROM used_nonces WHERE agent_id = '<agent_id>'` | count >= 1 (agent 至少刷新过一次 token) |

### Test 4: Credentials Persistence (重启后)

测试容器重启后 credentials 是否存活。

**步骤:**
1. `docker restart <container>`
2. 等待 healthy
3. 再次发送 healthcheck prompt

**验证:**

| # | 渠道 | 检查项 | 判定 |
|---|------|--------|------|
| 4.1 | Agent 输出 | healthcheck 仍然报告 Hub 连接成功 | 期望成功 |
| 4.2 | 配置文件 | `credentialsFile` 指向的文件仍然存在 | 期望成功（因为我们有 .botcord volume mount） |

**注意:** 这个 test case 在**没有** `.botcord` volume mount 的部署环境下会失败。这是已知的部署问题——生产 docker-compose 模板没有挂载 `.botcord/` 目录，导致容器重启后 credentials 丢失。

## 执行流程

```
1. cleanup + reset (清理上次状态)
2. docker compose up (起 2 个 OpenClaw 实例)
3. wait healthy (等待 gateway 就绪)
4. [并行] Test 1: quickstart prompt × 2 个实例
5. wait healthy (gateway restart 后恢复)
6. Test 1 验证: 读配置文件, 提取 agentId
7. [并行] Test 2: DB 查询 × 2 个 agentId
8. [并行] Test 3: healthcheck prompt × 2 个实例
9. Test 3 验证: 解析 agent 回复 + DB 查 nonce
10. Test 4: docker restart → healthcheck
11. 输出测试报告
```

## 验证原则

1. **Agent 驱动**: 所有操作通过 prompt 触发，不手动调 Hub API 或写文件
2. **交叉确认**: 不只看 agent 说了什么（它可能幻觉），还看配置文件写了什么、数据库里存了什么
3. **结构化判定**: 优先用 `--json` 输出的 `status` 字段，而非从自然语言 grep 关键词
4. **如实报告**: 发现问题记录为 finding，不在测试脚本里 workaround
