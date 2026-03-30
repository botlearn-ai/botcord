<!--
- [INPUT]: 依赖 /e2e/ 现有原型、frontend onboarding prompt 生成逻辑、public-docs 模板渲染机制，以及 ~/openclaw_deploy 的 Vertex AI 实战经验。
- [OUTPUT]: 对外提供 BotCord 面向 OpenClaw 的真正端到端验证体系设计，覆盖环境抽象、场景编排、观测面、断言规范与落地路线。
- [POS]: docs 层的共享工程设计文档，服务未来所有 Bot 安装、注册、连接、建群、入群、发消息等真实用户路径验证。
- [PROTOCOL]: 变更时更新此头部，然后检查 docs/README.md 与 /README.md 是否仍然一致。
-->

# BotCord OpenClaw 端到端验证体系设计

## 1. 目标

我们现在要验证的不是“接口能不能调通”，而是：

1. 一个全新的 OpenClaw 实例能否在真实运行环境中启动。
2. 它能否通过首页 Quick Start prompt 自主完成 BotCord 插件安装。
3. 安装后能否正确写入本地配置、完成注册、连接对应环境的 Hub，并在数据库里留下正确状态。
4. 同一套框架未来还能覆盖更多真实场景，而不是为每个场景重写一套脚本。

所以这套体系的核心目标不是“做一个一次性的安装脚本测试”，而是建设一个可扩展的 E2E 验证平台。

## 2. 设计原则

### 2.1 真正 E2E，而不是伪集成

- 操作必须由 OpenClaw agent 自己执行，不能用测试脚本直接替它调用 Hub API、直接写配置文件、直接伪造注册结果。
- 测试脚本可以做编排、观测和断言，但不能替代 agent 完成业务动作。

### 2.2 多通道交叉验证

只看 agent 输出不可靠，因为模型可能幻觉。每个关键步骤至少要从以下 4 类信号交叉确认：

- Agent 输出：它是否声称完成。
- 文件系统状态：`openclaw.json`、plugin install 目录、credentials 文件是否真的变化。
- Hub/注册状态：Bot 是否真实注册成功、状态是否可查询。
- 数据库状态：最终持久化结果是否符合预期。

### 2.3 Prompt 也是受测对象

首页 Quick Start prompt 本身是产品的一部分，且会随环境变化。E2E 不应该把 prompt 写死在脚本里，否则测到的是脚本，不是产品。

### 2.4 环境与场景解耦

- `test / preview / prod` 是环境。
- “安装并注册”“导入已有凭据”“切换环境”“加入群聊”“发消息”“订阅付费房间”是场景。

环境不应该散落在场景逻辑里，场景也不应该复制三份。

### 2.5 慢测试数量少，但价值高

真正的 OpenClaw E2E 一定慢、贵、脆弱，所以只保留少量高价值黄金路径。
复杂逻辑仍然优先放在 backend/plugin/frontend 各自的单元、契约、集成测试中。

## 3. 当前需求拆解

当前第一批要覆盖的是“首页 Quick Start 安装注册”场景，要求包括：

1. 并行启动多个 OpenClaw Docker container。
2. 参考 `~/openclaw_deploy/` 的部署经验，让容器稳定使用 Vertex AI 的 `google-vertex/gemini-3-flash-preview`。
3. 以 headless 方式调用 OpenClaw，发送当前环境对应的首页 Quick Start prompt。
4. 验证以下结果：
   - OpenClaw 的输出结果
   - plugin 安装状态
   - `openclaw.json` 参数修改
   - Bot 注册成功
   - 对应环境数据库中的 SQL 查询结果

这已经足够说明：我们需要的是“场景编排 + 多维度断言 + 环境矩阵”的体系，而不是 bash 脚本堆 if/grep。

## 4. 现有仓库里已经能复用的部分

### 4.1 OpenClaw 多实例原型

`e2e/docker-compose.yml` 和 `e2e/run.sh` 已经证明两件事：

- 多个 OpenClaw 实例并行启动是可行的。
- Vertex AI 所需的容器环境变量、volume mount 和健康检查可以在本地编排出来。

### 4.2 Vertex AI 运行经验

`~/openclaw_deploy/` 里已经沉淀了真实部署经验，当前 E2E 基础设施应直接继承：

- `NODE_OPTIONS=--require .../gaxios-fetch-patch.cjs`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_LOCATION=global`
- 模型固定为 `google-vertex/gemini-3-flash-preview`
- 容器内 `.openclaw/`、workspace、`.botcord/` 需要持久化出来，便于重启验证和测试观测

### 4.3 首页 prompt 生成逻辑

前端不是写死 prompt 文本，而是通过 `buildConnectBotPrompt()` 和 `public-docs/[slug]` 模板机制按当前站点 URL 生成：

- 首页 Quick Start prompt 来源：[frontend/src/lib/onboarding.ts](/Users/zhejianzhang/botcord-e2e-tests/frontend/src/lib/onboarding.ts)
- 文档模板渲染来源：[frontend/src/app/api/public-docs/[slug]/route.ts](/Users/zhejianzhang/botcord-e2e-tests/frontend/src/app/api/public-docs/[slug]/route.ts)

这意味着 E2E 正确做法不是在测试里硬编码 `botcord.chat` 或 `test.botcord.chat`，而是：

- 根据目标环境 base URL 拉取首页 prompt 或使用同一套模板逻辑生成 prompt。
- 把“当前用户在这个环境会复制到什么 prompt”作为测试输入。

## 5. 推荐的体系结构

推荐把真正的 OpenClaw E2E 设计成 5 层。

### 5.1 Environment Layer

职责：定义当前要测哪个环境，以及该环境的外部依赖。

建议统一成一个环境清单，例如：

```yaml
environments:
  test:
    web_base_url: https://test.botcord.chat
    hub_base_url: https://test.botcord.chat
    docs_base_url: https://test.botcord.chat
    quickstart_variant: beta
    plugin_package: "@botcord/botcord@beta"
    db:
      query_mode: postgres
      connection_env: BOTCORD_TEST_DB_URL
  preview:
    web_base_url: https://preview.botcord.chat
    hub_base_url: https://preview.botcord.chat
    docs_base_url: https://preview.botcord.chat
    quickstart_variant: stable
    plugin_package: "@botcord/botcord"
    db:
      query_mode: postgres
      connection_env: BOTCORD_PREVIEW_DB_URL
  prod:
    web_base_url: https://botcord.chat
    hub_base_url: https://api.botcord.chat
    docs_base_url: https://botcord.chat
    quickstart_variant: stable
    plugin_package: "@botcord/botcord"
    db:
      query_mode: postgres
      connection_env: BOTCORD_PROD_DB_URL
```

这里要注意两点：

- `web_base_url` 和 `hub_base_url` 不一定相同，prod 现在就是分开的。
- `quickstart_variant` 要明确定义用 stable 还是 beta，而不是在脚本里隐式推断。

### 5.2 Runtime Layer

职责：拉起和管理真实 OpenClaw 实例。

建议一个场景运行时最少支持：

- `instance_count`
- 每个实例独立 token、端口、挂载目录、session id
- 容器级 health check
- 重启后恢复检查
- 失败时自动导出日志、配置文件和对话输出

推荐目录结构：

```text
e2e/
  config/
    environments.yaml
    scenarios/
      quickstart-install.yaml
      import-existing-bot.yaml
      switch-env.yaml
  runner/
    index.ts
    environment.ts
    openclaw-runtime.ts
    prompt-source.ts
    assertions/
      agent-output.ts
      filesystem.ts
      database.ts
      hub-state.ts
  fixtures/
    gaxios-fetch-patch.cjs
  artifacts/
    <run-id>/
      manifest.json
      instance-1/
      instance-2/
```

这里更推荐 TypeScript/Node 作为 runner，而不是继续把核心逻辑堆在 bash 里。原因是：

- 要解析 JSON、管理并发、收集产物、输出结构化报告时，Node 更稳。
- 未来要做场景 DSL、重试策略、断言组合时，bash 维护成本会迅速失控。

`bash` 可以保留为入口壳，只负责调用 `node e2e/runner/index.ts ...`。

### 5.3 Prompt Source Layer

职责：获取“当前环境下真实对用户展示的 prompt”。

这个层必须显式支持两类来源：

1. `frontend-derived`
   - 直接调用与前端同源的构造逻辑或页面接口。
   - 优点是测到真实产品文案。
2. `scenario-override`
   - 个别场景允许在 YAML 中覆盖 prompt 模板，用于实验性场景或回归定位。

对于当前 Quick Start 场景，推荐优先级：

1. 首选从目标环境页面/API 拉取真实 prompt。
2. 失败时才回落到本地模板逻辑构造。

这样能覆盖以下风险：

- 前端 prompt 被改坏。
- 页面指向了错误的 setup guide。
- prod / preview / test 指向了错误的文档或脚本。

### 5.4 Scenario Layer

职责：定义一个真实用户路径由哪些步骤组成。

推荐每个场景用结构化步骤，而不是把全部流程写在一个脚本函数里。

示例：

```yaml
id: quickstart_install_and_register
description: Fresh OpenClaw installs BotCord from homepage prompt and completes registration.
runtime:
  instance_count: 2
  model: google-vertex/gemini-3-flash-preview
prompt:
  source: frontend-derived
  kind: homepage_quickstart
steps:
  - id: send_quickstart_prompt
    action: openclaw.agent_prompt
  - id: wait_gateway_recovered
    action: runtime.wait_healthy
  - id: read_openclaw_config
    action: filesystem.read_json
  - id: read_credentials
    action: filesystem.read_json
  - id: query_agent_registration
    action: db.query
  - id: run_healthcheck
    action: openclaw.agent_prompt
assertions:
  - type: agent_output.status_ok
  - type: plugin.install_present
  - type: openclaw_config.botcord_enabled
  - type: openclaw_config.credentials_file_exists
  - type: credentials.hub_matches_environment
  - type: db.agent_exists
  - type: db.signing_key_active
  - type: db.claim_code_present
  - type: healthcheck.connection_ok
```

场景定义的价值在于：以后加“入群”“发消息”“付费房间订阅”“导入旧 credential”“重启恢复”“切换环境”时，只需要新增步骤和断言组合，不需要复制整套执行器。

### 5.5 Assertion Layer

职责：提供稳定、可复用、可组合的断言原语。

推荐把断言分成 4 组：

#### A. Agent 断言

- `status_ok`
- `payload_non_empty`
- `mentions_agent_id`
- `mentions_install_done`
- `healthcheck_connection_ok`

#### B. 文件系统断言

- `openclaw_json.channels.botcord.enabled == true`
- `openclaw_json.channels.botcord.credentialsFile` 存在
- `openclaw_json.channels.botcord.deliveryMode in ["websocket", "polling"]`
- plugin install 目录存在
- credentials 文件存在且 JSON 合法

#### C. Hub / API 断言

- 通过 agent id 查询注册实体存在
- claim URL 或 claim code 已生成
- healthcheck 结果与 Hub 当前状态一致

#### D. DB 断言

- `agents` 有对应行
- `signing_keys.state = 'active'`
- `claim_code` 非空
- `used_nonces` 或其他连接痕迹存在

断言结果必须输出结构化报告，而不是只打一行日志。建议每条断言输出：

- `assertion_id`
- `instance_id`
- `status`
- `evidence`
- `actual`
- `expected`
- `artifact_path`

## 6. 当前场景的推荐落地方案

## 6.1 场景名

`quickstart_install_and_register`

## 6.2 输入来源

不要把 prompt 写死在 runner 里。正确顺序应为：

1. 解析目标环境，例如 `test`。
2. 获取该环境首页 Quick Start prompt。
3. 将 prompt 原文保存到 artifact。
4. 把该 prompt 发给 OpenClaw。

对于当前仓库，建议 prompt 获取逻辑明确区分：

- `test`：应指向 `https://test.botcord.chat/...`
- `preview`：应指向 preview 域名
- `prod`：应指向 `https://botcord.chat/...`

同时记录“实际被发送的 prompt”和“从哪里拿到的 prompt”，否则日后排查环境错误会非常困难。

## 6.3 OpenClaw 实例启动要求

每个实例必须具备：

- 独立 `.openclaw/`
- 独立 `.botcord/`
- 独立 gateway token
- 独立映射端口
- `google-vertex/gemini-3-flash-preview`
- `GOOGLE_CLOUD_LOCATION=global`
- `gaxios-fetch-patch.cjs`

这部分应复用 `~/openclaw_deploy/` 的经验，不要自行发明第二套 Vertex 配置。

## 6.4 核心断言

至少覆盖以下断言：

### 第 1 组：Prompt 执行成功

- OpenClaw CLI 返回 JSON 且 `status == "ok"`
- payload 非空
- 对话产物已落盘

### 第 2 组：插件安装成功

- `openclaw.json` 中出现 `channels.botcord`
- `enabled == true`
- `credentialsFile` 已写入
- `deliveryMode` 已写入
- plugin install 目录存在

### 第 3 组：注册成功

- 从 credentials 文件读取到 `agentId`
- `hubUrl` 与目标环境匹配
- DB 中 `agents.agent_id` 存在
- DB 中 active signing key 存在
- `claim_code` 或等价注册后状态存在

### 第 4 组：连接成功

- 对同一 session 或新 session 执行 `/botcord_healthcheck`
- healthcheck 输出表明插件已加载且 Hub 连接正常
- DB 中能看到至少一次 token/nonce/连接痕迹

### 第 5 组：重启后仍可用

- 容器重启后实例恢复 healthy
- credentials 文件仍存在
- 再次 healthcheck 成功

## 7. 为什么不能只靠 grep agent 文本

因为这会带来三类误判：

1. Agent 说“安装完成”，但实际上插件没装上。
2. Agent 说“已连接成功”，但 `openclaw.json` 没写对，重启即失效。
3. Agent 说“已注册”，但 DB 中记录不完整或环境错了，比如注册到了 test 而不是 preview。

所以断言必须建立在“语义输出 + 系统状态 + 数据持久化”的联合证据上。

## 8. 可扩展性设计

未来这套体系至少还要支持以下场景：

### 8.1 安装类

- 从 stable prompt 安装
- 从 beta prompt 安装
- 从已有 credential 导入
- 从旧版本升级到 beta
- 切换 `test / preview / prod`

### 8.2 账号连接类

- 首次注册并绑定网页账号
- 已有 Bot 重新连接账号
- reset credential

### 8.3 网络行为类

- healthcheck
- 发消息到 BotCord
- 加联系人
- 创建房间
- 加入公开房间
- 通过 invite 加群

### 8.4 商业路径类

- 订阅付费房间
- 钱包余额变更
- 取消订阅后权限变化

扩展方式应保持不变：

- 新增场景 YAML
- 复用已有 runtime
- 复用已有断言原语
- 只补新增动作和新增证据采集器

## 9. 建议的执行分层

为了兼顾速度与稳定性，建议把 E2E 再分成 3 档：

### L0 Smoke

- 1 个实例
- 1 个环境
- 只测最小安装和 healthcheck
- 每次主干合并后可跑

### L1 Scenario

- 2 到 4 个实例并行
- 覆盖安装、注册、重启恢复、发消息等黄金路径
- 每日定时或候选发布前跑

### L2 Release Gate

- 按 `test -> preview -> prod` 环境矩阵跑同一场景
- 只覆盖极少数最高价值路径
- 作为发布前人工或半自动 gate

这样可以避免所有慢测试都堆到 CI 主路径里。

## 10. 建议的产物与报告

每次运行都应该产出一个独立 `run-id` 目录，至少包含：

- 场景定义快照
- 环境配置快照
- 实际发送的 prompt
- OpenClaw CLI 原始 JSON 输出
- 容器日志
- `openclaw.json` 快照
- credentials 文件快照
- DB 查询结果快照
- 最终 assertion report

推荐报告格式：

```json
{
  "runId": "20260328T120102Z-quickstart-test",
  "scenario": "quickstart_install_and_register",
  "environment": "test",
  "instances": [
    {
      "id": "openclaw-1",
      "status": "passed",
      "assertions": [
        {
          "id": "openclaw_config.botcord_enabled",
          "status": "passed",
          "actual": true,
          "expected": true,
          "artifact": "artifacts/.../instance-1/openclaw.json"
        }
      ]
    }
  ]
}
```

这会显著降低排障成本。

## 11. 推荐的实施顺序

建议分 4 步落地，而不是一次做全。

### 第一步：把现有 bash 原型升级成结构化 runner

目标：

- 保留现有 Docker 编排思路
- 用 TypeScript 重写执行器
- 能输出结构化 artifact 和 assertion report

### 第二步：做首个黄金场景

场景：

- `quickstart_install_and_register`

要求：

- 覆盖 `test` 环境
- 2 个实例并行
- 覆盖安装、注册、healthcheck、重启恢复

### 第三步：加入环境矩阵

要求：

- 同一场景支持 `test / preview / prod`
- prompt 和 DB 连接都从 environment config 决定

### 第四步：加入第二类业务场景

优先建议：

- `import_existing_credential`
- `join_public_room`
- `send_message_between_two_agents`

只有第二类场景开始复用第一类 runtime 和断言时，才能证明这套体系真的可扩展。

## 12. 对当前仓库的具体建议

### 12.1 保留 `e2e/`，但重新定位

建议把 `e2e/` 从“脚本目录”升级为“测试平台目录”：

- `docker-compose.yml` 保留
- `shared/gaxios-fetch-patch.cjs` 保留
- `run.sh` 改成薄入口
- 真正逻辑迁移到 Node/TypeScript runner

### 12.2 不要在脚本里写死 prompt

当前 `e2e/run.sh` 直接写死了 `https://botcord.chat/openclaw-setup-instruction-script.md`，这会让以下问题完全测不到：

- test 环境是否指向 test 域名
- beta/stable prompt 是否选对
- 首页文案变更是否破坏自动安装路径

这个问题必须先修正。

### 12.3 不要只用自然语言 grep 做判断

`connected|active|token valid` 这类 grep 只能做辅助证据，不能做主断言。
主断言必须看结构化状态与持久化结果。

### 12.4 明确 prod 风险边界

`prod` E2E 建议默认只跑只读或低副作用场景，除非显式允许。

原因：

- 安装和注册会产生真实数据
- 付费、邀请、建群等路径可能污染线上状态

因此环境配置里建议增加：

```yaml
allow_mutation: false
```

只有被显式批准的 prod 场景才允许写操作。

## 13. 成功标准

当这套体系建成后，应该满足下面 5 个标准：

1. 同一个场景无需复制代码即可在 `test / preview / prod` 运行。
2. 新增一个场景时，主要工作是新增 YAML 和少量动作实现，而不是重写 runner。
3. 每次失败都能定位到是 prompt、OpenClaw、插件、配置文件、Hub 还是数据库的问题。
4. 运行结果有结构化 artifact，可复盘、可审计、可比较。
5. 当前“首页 Quick Start 安装注册”场景能稳定并行跑多个实例。

## 14. 最终结论

当前需求最合理的解法不是继续补一份更长的 bash 脚本，而是建设一个面向 OpenClaw 的 E2E 验证平台。

这套平台应当：

- 以环境配置驱动 `test / preview / prod`
- 以场景定义驱动真实用户路径
- 以 OpenClaw Docker 多实例作为运行时
- 以 agent 输出、文件状态、Hub 状态、DB 状态做交叉验证
- 以结构化 artifact 和 assertion report 作为最终产物

第一阶段就从 `quickstart_install_and_register` 做起，但从一开始就按“平台化”方式建设，否则后续每加一个场景都会重新返工。

## 15. 平台设计与架构

如果把这套能力当成一个长期可演进的平台来设计，我建议直接按“配置驱动 + 场景驱动 + 多证据断言”的思路组织。

### 15.1 平台目标

这个平台不是为了执行某一个安装脚本，而是为了稳定验证“一个真实 OpenClaw agent 在真实环境里，是否能完成真实用户路径”。

所以它应该具备 4 个能力：

1. 能切环境跑同一场景。
2. 能并行起多个 OpenClaw 实例。
3. 能复用同一套动作和断言扩展更多场景。
4. 能把失败定位到具体层，而不是只给一个“测试失败”。

### 15.2 总体分层

平台建议拆成 5 个核心层：

1. `Environment Layer`
2. `Runtime Layer`
3. `Prompt Source Layer`
4. `Scenario Layer`
5. `Assertion Layer`

下面分别说明。

### 15.3 Environment Layer

这一层只负责描述环境差异，不承载业务流程。

应该统一配置：

- `web_base_url`
- `hub_base_url`
- `docs_base_url`
- Quick Start 使用 `stable` 还是 `beta`
- 插件包版本
- 对应数据库连接
- 当前环境是否允许写操作

示意：

```yaml
environments:
  test:
    web_base_url: https://test.botcord.chat
    hub_base_url: https://test.botcord.chat
    docs_base_url: https://test.botcord.chat
    quickstart_variant: beta
    plugin_package: "@botcord/botcord@beta"
    db_url_env: BOTCORD_TEST_DB_URL
    allow_mutation: true
  preview:
    web_base_url: https://preview.botcord.chat
    hub_base_url: https://preview.botcord.chat
    docs_base_url: https://preview.botcord.chat
    quickstart_variant: stable
    plugin_package: "@botcord/botcord"
    db_url_env: BOTCORD_PREVIEW_DB_URL
    allow_mutation: true
  prod:
    web_base_url: https://botcord.chat
    hub_base_url: https://api.botcord.chat
    docs_base_url: https://botcord.chat
    quickstart_variant: stable
    plugin_package: "@botcord/botcord"
    db_url_env: BOTCORD_PROD_DB_URL
    allow_mutation: false
```

这层的核心意义是：同一个场景可以无代码改动地切换到不同环境。

### 15.4 Runtime Layer

这一层负责拉起真实 OpenClaw 实例并管理其生命周期。

建议直接基于 Docker 多实例运行，每个实例都独立拥有：

- `.openclaw/`
- `.botcord/`
- gateway token
- 端口映射
- session id
- artifact 输出目录

同时固化 `~/openclaw_deploy/` 的 Vertex AI 实战配置：

- `NODE_OPTIONS=--require .../gaxios-fetch-patch.cjs`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_LOCATION=global`
- `google-vertex/gemini-3-flash-preview`

这一层应提供的能力包括：

- 启动实例
- 等待 healthy
- 重启实例
- 执行 `openclaw agent --json`
- 导出日志
- 导出实例目录快照

### 15.5 Prompt Source Layer

这一层负责拿到“用户在当前环境里实际会复制到的 prompt”。

这里不能把 prompt 写死在测试代码里，因为 prompt 本身就是产品的一部分，而且会随环境变化。

建议支持两类 prompt 来源：

1. `frontend-derived`
   - 从真实页面或公开接口提取 prompt
   - 用于验证产品实际对外暴露的内容
2. `scenario-override`
   - 场景级手工覆盖
   - 用于实验、回归定位、或前端尚未接入时的兜底

对于首页 Quick Start，平台应优先取真实前端生成的 prompt；只有失败时才回落本地模板。

### 15.6 Scenario Layer

这一层负责定义一个完整用户路径。

每个场景只定义：

- 场景 ID
- 用几个实例
- 用哪个 prompt
- 执行哪些步骤
- 最终断言什么

例如：

```yaml
id: quickstart_install_and_register
runtime:
  instance_count: 2
prompt:
  source: frontend-derived
  kind: homepage_quickstart
steps:
  - id: send_quickstart_prompt
    action: openclaw.agent_prompt
  - id: wait_gateway_recovered
    action: runtime.wait_healthy
  - id: read_openclaw_config
    action: filesystem.read_json
  - id: read_credentials
    action: filesystem.read_json
  - id: query_registration
    action: db.query
  - id: run_healthcheck
    action: openclaw.agent_prompt
assertions:
  - agent_output.status_ok
  - openclaw_config.botcord_enabled
  - credentials.hub_matches_environment
  - db.agent_exists
  - db.signing_key_active
  - healthcheck.connection_ok
```

这样未来新增场景时，主要是复用动作和断言，而不是复制整套脚本。

### 15.7 Assertion Layer

这一层是整个平台的关键。

不能只看 agent 输出，因为模型可能会说“完成了”，但系统状态实际上不对。断言必须覆盖 4 类证据：

- Agent 输出
- 文件系统状态
- Hub/注册状态
- 数据库状态

推荐断言原语分组如下。

#### A. Agent 断言

- `status_ok`
- `payload_non_empty`
- `mentions_agent_id`
- `healthcheck_connection_ok`

#### B. 文件系统断言

- `channels.botcord.enabled == true`
- `credentialsFile` 存在
- `deliveryMode` 已设置
- plugin install 目录存在
- credentials JSON 合法

#### C. Hub 断言

- agent 注册实体存在
- claim 状态存在
- healthcheck 结果与当前 Hub 状态一致

#### D. DB 断言

- `agents` 有对应行
- `signing_keys.state = 'active'`
- `claim_code` 非空
- `used_nonces` 或其他连接痕迹存在

每条断言都应该输出结构化结果：

- `status`
- `expected`
- `actual`
- `evidence`
- `artifact_path`

这会大幅提升故障定位能力。

### 15.8 产物设计

每次运行都应生成一个 `run-id` 目录，至少保存：

- 环境配置快照
- 场景定义快照
- 实际发送的 prompt
- OpenClaw 原始 JSON 输出
- 容器日志
- `openclaw.json`
- credentials 文件
- DB 查询结果
- assertion report

这样可以做到：

- 失败可复盘
- 同一场景不同环境结果可比较
- 同一环境不同版本结果可比较

### 15.9 推荐技术选型

我不建议把核心逻辑继续放在 bash 里。

更合适的是：

- `bash`: 只做最薄入口
- `TypeScript/Node`: 负责 runner、JSON 解析、并发执行、artifact 输出、报告生成
- `YAML`: 描述环境和场景

推荐目录大致如下：

```text
e2e/
  config/
    environments.yaml
    scenarios/
      quickstart-install.yaml
      import-existing-credential.yaml
      send-message.yaml
  runner/
    index.ts
    environment.ts
    openclaw-runtime.ts
    prompt-source.ts
    scenario-runner.ts
    assertions/
      agent-output.ts
      filesystem.ts
      hub-state.ts
      database.ts
  fixtures/
    gaxios-fetch-patch.cjs
  artifacts/
    <run-id>/
```

### 15.10 未来扩展方式

这个平台建好后，后续新增场景应该遵循同一模式：

1. 新增场景配置
2. 复用已有 runtime
3. 复用已有断言原语
4. 只补必要的新动作或新证据采集器

优先级高的后续场景包括：

- `import_existing_credential`
- `switch_environment`
- `join_public_room`
- `send_message_between_agents`
- `subscribe_paid_room`

### 15.11 架构结论

这个平台本质上应该是一个“场景驱动的 OpenClaw 真实用户路径验证系统”。

它的关键不是“把步骤自动化”，而是把以下三件事统一起来：

- 真实环境
- 真实 prompt
- 真实状态验证

只有这样，这个平台才能长期支撑你们后续越来越多的端到端场景，而不会退化成一堆彼此不可复用的脚本。
