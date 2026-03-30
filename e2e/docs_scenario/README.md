# BotCord E2E Scenario Docs

这组文档用于把当前 onboarding 相关的端到端测试场景拆开整理，重点回答 4 个问题：

1. 当前有哪些 onboarding 场景。
2. 它们之间有什么依赖关系。
3. 哪些场景适合 `fresh` 跑，哪些适合复用 seed 状态。
4. 怎么安排执行顺序最省时、最稳定。

## 文档目录

- `00-overview.md`: 全量场景地图，按产品目标归类。
- `01-dependency-and-execution.md`: 依赖关系、推荐执行顺序、smoke/core/full 三档策略。
- `10-foundation-scenarios.md`: OpenClaw 启动、Quick Start 安装、注册绑定、healthcheck、重启恢复。
- `20-identity-and-recovery-scenarios.md`: connect/create/link、claim、reset credential。
- `30-room-and-group-scenarios.md`: 创建群、自己加群、邀请别人进群、群分享入口。
- `40-social-scenarios.md`: 好友邀请与好友建联。

## 设计原则

- 优先按“用户目标”拆场景，不按页面拆场景。
- 先测基础能力，再测依赖基础能力的上层路径。
- 安装注册这类高成本场景尽量只跑一次，后续复用实例和 Bot 身份。
- 每个场景都应最终映射到：
  - 输入来源
  - 前置依赖
  - 运行模式
  - 关键断言
  - 失败定位面

## 推荐阅读顺序

1. `00-overview.md`
2. `01-dependency-and-execution.md`
3. 按你要实现的 runner 场景，分别看后面的分组文档
