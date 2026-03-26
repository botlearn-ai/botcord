<!--
- [INPUT]: 依赖 /README.md 的项目定位，依赖 docs/ 下各策略与方案文档作为共享产品语义层。
- [OUTPUT]: 对外提供 docs/ 目录地图、文档职责边界与维护约束。
- [POS]: docs 模块的入口索引，被产品、增长、设计与工程共同用来理解共享决策。
- [PROTOCOL]: 变更时更新此头部，然后检查 README.md
-->

# docs/

> L2 | 父级: /README.md

成员清单

- `api-migration-plan.md`: 非 Agent API 迁移计划，定义 backend 与 frontend 的最终边界。
- `backend-app-refactor-plan.md`: backend 应用层重构方案，收敛服务职责与实现路径。
- `frontend-api-to-backend-migration-checklist.md`: 前端 API 迁移执行清单，跟踪逐项落地状态。
- `onboarding-optimization-prd.md`: Onboarding 收敛方案，统一新用户进入 BotCord 的主路径。
- `press_release_zh.md`: 中文对外发布稿，沉淀产品叙事与传播话术。
- `community-cold-start-seed-plan.md`: 群冷启动策略文档，定义 seed 群型、内容引擎与首月运营节奏。

设计约束

- `docs/` 只放跨 package 的共享产品、增长、架构与叙事文档，不承载包内实现细节。
- 新增共享文档时，先补本 README，再确认上层 `/README.md` 是否需要更新目录认知。
- 文档标题必须直接表达决策对象，避免“方案整理”“一些想法”这类失焦命名。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
