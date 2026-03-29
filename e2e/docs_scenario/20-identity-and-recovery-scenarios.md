# Identity 与 Recovery 场景

## 目标

这组场景主要验证用户身份接入与恢复流程，包括：

- 连接已有 Bot
- 创建新 Bot
- 认领已有 Bot
- 重置 credential

## S4_claim_existing_bot

### 目标

验证 claim 兼容页可以把一个已有 Bot 认领到当前用户账号下。

### 前置依赖

- 一个已注册但未归属当前用户的 Bot（`user_id IS NULL`）
- 在 E2E 中，通过 S1/S2 的安装注册流程产出的 agent 天然处于这个状态——插件注册 agent 但不会自动 bind 到 dashboard 用户。所以 S4 可以直接复用 S2 的产物，不需要特殊种子。
- 依赖图中 S4 位于 S2 下方，指的是需要 S2 的注册产物（而非绑定状态）。

### 运行模式

- `seeded`

### 最小实例数

- 1

### 关键断言

- claim URL 可访问
- 登录后 claim 成功
- `agents.user_id` 归属变化符合预期
- 页面继续跳转到正确目标页

### 风险点

- 这是兼容流程，不是主流程
- 不适合和主 onboarding 混在同一 smoke 套件里

## S5_reset_credential

### 目标

验证 reset credential prompt 可以为现有 Bot 重建本地 credential，而不改变 Bot 身份。

### 前置依赖

- `S2_register_and_bind`

### 运行模式

- `seeded`

### 最小实例数

- 1

### 关键断言

- reset code 签发成功
- Prompt 可复制并执行
- 新 credentials 写入成功
- `agentId` 不变
- 后续 healthcheck 正常

### 特别价值

这是非常高价值的恢复型场景，优先级很高。

## S6_link_existing_bot

### 目标

验证当用户明确选择 `link` 模式时，OpenClaw 优先连接已有 Bot，而不是新建 Bot。

### 前置依赖

- `S1_quickstart_install`
- 已有 Bot credential 在本地（link 的前提是有一个可以连回去的身份）

### 运行模式

- `seeded`（需要已有身份作为 link 目标；standalone 模式下内置 S1 replay 产出 seed）

### 最小实例数

- 1

### 关键断言

- 最终绑定的是已有 `agentId`
- 未额外创建第二个 Bot
- 配置文件与 credentials 指向原身份

## S7_create_new_bot

### 目标

验证用户明确要求创建新 Bot 时，系统确实创建新身份，而不是复用已有身份。

### 前置依赖

- `S1_quickstart_install`

### 运行模式

- `seeded`（需要已有身份作为对照基线；standalone 模式下内置 S1 replay 产出 seed）

### 最小实例数

- 1

### 关键断言

- 新的 `agentId` 被创建
- 与已有身份不同
- 新 agent 在 Hub 注册成功

## 推荐优先级

这组场景里优先级建议：

1. `S5_reset_credential`
2. `S6_link_existing_bot`
3. `S7_create_new_bot`
4. `S4_claim_existing_bot`

理由：

- `reset_credential` 是高价值恢复路径
- `link/create` 直接关系到 Prompt 模板的模式分支
- `claim` 是兼容入口，价值较高但不应该压过主路径
