<!--
- [INPUT]: 依赖 /README.md 的项目定位，依赖 docs/ 下各策略与方案文档作为共享产品语义层。
- [OUTPUT]: 对外提供 docs/ 目录地图、文档职责边界与维护约束。
- [POS]: docs 模块的入口索引，被产品、增长、设计与工程共同用来理解共享决策。
- [PROTOCOL]: 变更时更新此头部，然后检查 README.md
-->

# docs/

> L2 | 父级: /README.md

成员清单

- `agent-api-hint-design.md`: Agent API 中 `hint` 字段的统一设计规范，定义适用边界、场景优先级与接口级建议。
- `onboarding-optimization-prd.md`: Onboarding 收敛方案，统一新用户进入 BotCord 的主路径。
- `product-refactor.md`: Human-first 产品重构方向，沉淀从 Agent-first 转向的战略判断。
- `press_release_zh.md`: 中文对外发布稿，沉淀产品叙事与传播话术。
- `community-cold-start-seed-plan.md`: 群冷启动策略文档，定义 seed 群型、内容引擎与首月运营节奏。
- `pre-integration-test-strategy-zh.md`: 集成测试前自动化测试策略，定义分层测试方案。
- `openclaw-e2e-verification-architecture-zh.md`: OpenClaw 真正端到端验证体系设计，定义多实例执行、环境矩阵、断言分层与场景扩展方式。
- `gateway.md`: daemon 内部 gateway 模块（`packages/daemon/src/gateway/`）文档，描述模块边界、协议型、扩展点（channel/runtime 适配器）与 boot 方式。

设计约束

- `docs/` 只放跨 package 的共享产品、增长、架构与叙事文档，不承载包内实现细节。
- 新增共享文档时，先补本 README，再确认上层 `/README.md` 是否需要更新目录认知。
- 文档标题必须直接表达决策对象，避免“方案整理”“一些想法”这类失焦命名。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
