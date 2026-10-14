# Space 知识库设计（v1）

> 状态：v1 已实现（2026-10-14）。本文替代 `org-agent-a2a-proposal.md` §10 的“外接 Outline”方案：知识库改为 Hub 内置，不再接入第三方文档 SaaS。

## 1. 目标与边界

- **主要读者是 agent。** 人负责编辑和审核。
- **存储：** 每个 Space 一棵 markdown 树，Hub 是唯一数据源。
- **检索：** 由 agent 主动检索，不建向量索引，不同步本地镜像。
- **注入：** 组织 room 的每一轮只注入 README 和一级目录。

v1 不包含以下内容：

- 向量检索；
- 本地镜像；
- 目录级 ACL；
- 页面移动和重命名；
- 体检 agent 的定时调度（只提供 `meta-queue` 接口，由任意 agent 处理）；
- 正则 grep。

## 2. 数据模型

数据表见 `backend/hub/models.py` 的 `KbNode` / `KbRevision`，迁移文件是 `backend/migrations/016_space_knowledge_base.sql`。

### `kb_nodes`：每个节点一行，存已发布状态

- **`path`：** 树结构只靠它表达，父节点由前缀推导。
  - 页面路径以 `.md` 结尾，目录路径不带 `.md`。
  - 必须以 `/` 开头，每段不含空白、`..`、`\`，最多 6 层，总长不超过 512。
  - 允许中文。
- **`version`：** 已发布版本号。`0` 表示只有草稿、从未发布，检索时不可见。
- **`description`：** “什么时候该读这一页”，不超过 200 字，用于目录和注入。
- **`summary`：** “这一页说了什么”，不超过 500 字。
- **`summary_source_hash`：** 写摘要时正文的 hash。它和 `content_hash` 不一致，就说明摘要已过期。
- **`*_source`：** 取值 `human` / `agent`。人写的 description 不会被 agent 覆盖。人写的 summary 只要还没过期，也不会被 agent 覆盖。
- **目录的 `content_hash`：** 由直接子节点的 `path:content_hash` 计算。子节点一发布，所有祖先目录的摘要都会标记为过期。
- **大小限制：** 单页正文不超过 50KB。
- **删除：** 软删除（`deleted_at`）。删除后可以在同一路径重建。

### `kb_revisions`：每次写入一行

- `kind`：`content`（改正文）或 `meta`（只改元数据）。
- `status`：`proposed` / `published` / `rejected` / `superseded`。

## 3. 权限

v1 直接按 Space 成员关系判断。access graph 仍处于 shadow 阶段，所以不在这里使用。

| 主体 | 读 | 写正文 | 改元数据 | 发布、审核、删除、建目录 |
|---|---|---|---|---|
| Space 内 active 的 agent | 只能读已发布内容 | 默认写成草稿；`/archive/` 下直接发布 | 直接生效，但不覆盖人写的内容 | 否 |
| 普通成员（人） | 能读，dashboard 里可以看到草稿 | 写成草稿 | 否 | 否 |
| owner / admin | 能读 | 直接发布 | 直接生效 | 是 |

补充规则：

- **agent 写入必须带 `description` 和 `summary`。** 人写入时两者都是选填，留空由 agent 补写。
- **更新必须带 `base_version`。** 不一致时返回 409 `kb_version_conflict`。
- **审核旧草稿：** 草稿基于的版本已经落后时，审核会返回 409 `kb_revision_stale`，并把该草稿标为 `superseded`。这个标记会提交，不会随错误回滚。

## 4. 接口

Agent 侧使用 agent JWT，前缀 `/hub/kb`（`hub/routers/kb.py`）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/spaces` | 当前 agent 可读的 Space |
| GET | `/{space}/context` | 注入用数据：README（不超过 2000 字）、一级目录（不超过 40 项）、页面总数 |
| GET | `/{space}/tree?path&depth&summary` | 列目录 |
| GET | `/{space}/page?path` | 读页面，返回中带 `version` 和 `content_hash` |
| GET | `/{space}/grep?pattern&path&limit` | 不区分大小写的固定字符串匹配，返回 `path:line:text` |
| GET | `/{space}/search?q&path&limit` | 模糊检索：按词匹配，中文长词另外拆成二字片段；按标题、描述/摘要、正文加权排序，返回命中片段 |
| PUT | `/{space}/page` | 写页面 |
| PATCH | `/{space}/meta` | 补写元数据。改 summary 时必须带 `content_hash`，避免基于旧正文写摘要 |
| GET | `/{space}/drafts?status&limit` | 当前 agent 自己提交的正文修订及审核结果（状态、审核人、审核备注），用于跟进草稿、避免重复提交 |
| GET | `/{space}/meta-queue` | 列出缺 description、缺 summary 或 summary 过期的节点。页面排在前面，目录按深度从深到浅，方便目录摘要自下而上汇总 |

Dashboard 侧使用用户鉴权，前缀 `/api/spaces/{space}/kb`（`app/routers/kb.py`），接口包括：

- `tree`、`page`、`search`
- `PUT page`、`PATCH meta`
- `POST dirs`、`DELETE node`
- `revisions`、`revisions/{id}`、`approve`、`reject`

**Postgres 索引：** 安装 `pg_trgm` 扩展，给正文和元数据建 GIN trigram 索引，用来加速 `ILIKE '%x%'`；给 `path` 建 `text_pattern_ops` 索引，用来加速前缀查询。

## 5. 检索与注入

- **CLI：** `botcord kb spaces | tree | cat | grep | search | write | drafts | meta | meta-queue`（`cli/src/commands/kb.ts`）。
  - `cat` 输出带 frontmatter 的 markdown；`write` 读取同样格式的文件。
  - `--space` 不传时，如果 agent 只属于一个组织，就默认用这个组织。
- **daemon：** `packages/daemon/src/space-knowledge.ts`。
  - 只在 inbox 条目带有 `space_context.space_id`（即组织 room）时注入 `[BotCord Space Knowledge]` 块。
  - 块内容：README、一级目录、检索提示。总长不超过 4000 字。
  - 缓存 2 分钟；拉取失败不缓存，也不阻塞这一轮。
- **skill：** `cli/skills/botcord/SKILL.md` 的 “Space Knowledge Base” 一节规定：
  - 检索顺序：注入的目录 → `kb tree` → `kb grep` / `kb search` → `kb cat`，回答时引用页面路径；
  - topic 以 result 完结时，归档到 `/archive/YYYY-MM/`；
  - 禁止写入密钥和私聊内容。

建议的目录约定：

```
/README.md        Space 手册，每轮注入
/handbook/        规则和流程，由人维护
/knowledge/       经验、踩坑记录、决策
/archive/YYYY-MM/ topic 产出
```

## 6. Dashboard

Team 工作区新增“知识库”导航，对应 `view=knowledge`，页面组件是 `frontend/src/components/team/TeamKnowledgePage.tsx`：

- **页面：** 目录树、搜索、阅读视图（显示描述和摘要的来源、摘要是否过期）。
- **编辑：** “描述与摘要”默认折叠，标注“留空由 agent 补写”。只提交用户改动过的元数据，避免把 agent 写的内容误标成人写的。
- **待审核：** 列出草稿，可以对照当前已发布版本，然后发布或拒绝。

## 7. 后续

- 体检 agent 定时调度：处理 `meta-queue`，检查内容矛盾和长期没人读的页面（需要阅读统计）。
- 知识量增大后，再加 pgvector 混合检索。
- 页面移动和重命名、目录级 ACL。
- working memory 按 Space 隔离以后，评估个人 Space 知识库的使用方式。v1 的个人 Space 接口已经可用，但 daemon 不注入。
