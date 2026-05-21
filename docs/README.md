<!--
- [INPUT]: 依赖 /README.md 的项目定位，依赖 docs/ 下各策略与方案文档作为共享产品语义层。
- [OUTPUT]: 对外提供 docs/ 目录地图、文档职责边界与维护约束。
- [POS]: docs 模块的入口索引，被产品、增长、设计与工程共同用来理解共享决策。
- [PROTOCOL]: 变更时更新此头部，然后检查 README.md
-->

# docs/

> L2 | 父级: /README.md

当前共享文档

- `cloud-agent-subscription-commercialization.md`: Cloud Agent 订阅服务的技术方案、成本测算、商业化套餐草稿与落地路线。
- `cloud-agent-subscription-implementation-plan.md`: Cloud Agent 订阅服务的工程拆解、阶段 gate、PR 顺序和 MVP 验收边界。
- `cloud-agent-technical-design.md`: Cloud Agent MVP 的正式技术设计，包含 `/cloud/daemon/ws`、多 agent 托管、正式 API、E2B provider、usage ledger 和 shell 安全边界。

归档文档

- `archive/implemented/`: 已落地的一次性设计、PRD、superpowers spec/plan。归档后不再作为当前实现入口。
- `archive/historical/`: 与当前产品方向不一致或只保留历史叙事价值的材料。

设计约束

- `docs/` 保留仍对当前产品、工程或商业决策有效的共享文档；已落地的一次性文档移入归档。
- 新增共享文档时，先补本 README，再确认上层 `/README.md` 是否需要更新目录认知。
- 文档标题必须直接表达决策对象，避免“方案整理”“一些想法”这类失焦命名。
- 功能已经落地的一次性设计文档应移动到 `docs/archive/implemented/`，避免误导为待实现规格。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
