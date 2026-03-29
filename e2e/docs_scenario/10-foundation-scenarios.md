# Foundation 场景

## 目标

Foundation 场景负责验证所有 onboarding 上层路径共同依赖的底座能力。

如果这一层不稳定，上层场景失败通常没有诊断价值。

## S0_openclaw_boot

### 目标

验证 OpenClaw 运行时本身健康：

- Docker 实例可启动
- Gateway healthy
- Vertex AI 所需环境变量和补丁生效
- `google-vertex/gemini-3-flash-preview` 可用

### 前置依赖

- 无

### 运行模式

- `fresh`

### 最小实例数

- 2

### 关键断言

- 容器启动成功
- `docker inspect` 显示 `healthy`
- `openclaw.json` 中模型配置正确
- 容器日志未出现 Vertex/gaxios 初始化错误

### 失败定位面

- Docker 编排错误
- Vertex 凭据错误
- OpenClaw 版本或镜像问题
- `gaxios-fetch-patch.cjs` 未生效

## S1_quickstart_install

### 目标

验证首页 Quick Start prompt 能让 OpenClaw 成功安装 BotCord。

### 前置依赖

- `S0_openclaw_boot`

### 运行模式

- `fresh`

### 最小实例数

- 2

### 输入来源

- 真实首页 Quick Start prompt

### 关键断言

- OpenClaw agent 返回 `status == ok`
- `channels.botcord` 出现在 `openclaw.json`
- `enabled == true`
- `credentialsFile` 已写入
- `deliveryMode` 已写入
- plugin 安装目录存在

### 失败定位面

- 首页 prompt 失真
- setup guide 地址错误
- OpenClaw 无法执行安装
- 插件安装脚本失败

## S2_register_and_bind

### 目标

验证安装后的 Bot 能正确注册到 Hub，并生成 claim_code 以便后续绑定到 dashboard 用户。

注意：在 E2E Docker 环境中没有真实的 Supabase 用户会话，所以"bind"的含义是：
- agent 在 Hub 注册成功（`agents` 表有记录）
- `claim_code` 已生成（用户拿到这个 code 后可以在 dashboard 完成绑定）
- `signing_keys` 中有 active key
- agent 此时 `user_id` 仍为 NULL（尚未被任何 dashboard 用户 claim）

这正是 S4_claim_existing_bot 所需要的前置状态。

### 前置依赖

- `S1_quickstart_install`

### 运行模式

- `fresh`

### 最小实例数

- 2

### 关键断言

- credentials 文件存在
- `agentId` 存在
- `hubUrl` 指向目标环境
- `agents` 表中有记录
- `signing_keys` 中存在 active key
- `agents.claim_code` 非空（bind 准备就绪）

### 失败定位面

- register 脚本失败
- bind code / bind ticket 流程失败
- DB 状态落库异常

## S3_healthcheck_and_restart

### 目标

验证安装绑定完成后，运行状态与重启恢复都正常。

### 前置依赖

- `S2_register_and_bind`

### 运行模式

- `seeded`

### 最小实例数

- 2

### 关键断言

- `/botcord_healthcheck` 输出正常
- 包含 agent id
- Hub 连接状态正常
- token/nonce 刷新痕迹存在
- 容器重启后 credentials 仍在
- 重启后 healthcheck 仍然正常

### 失败定位面

- plugin runtime 异常
- reconnect 逻辑异常
- `.botcord/` 未正确持久化

## 推荐实现顺序

如果是第一批 runner 落地，先只做这 4 个场景。

原因：

- 它们是后续所有 onboarding 流程的共同前置
- 它们能覆盖最核心的“安装 -> 注册 -> 连接 -> 重启恢复”链路
- 它们也是最适合先打通 artifact 和断言体系的一层
