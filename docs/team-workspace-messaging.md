# Team 消息工作区

2026-09-09。本地实现，尚未部署。

## 产品形态

进入 Team 后默认展示组织工作区：左侧组织与功能导航、中间会话列表、右侧消息区；手机在列表和会话之间切换。组织管理不再占用消息首页。

- 消息聚合房间与成员私聊，提供会话名称搜索、全部/未读筛选。
- 房间导航仅筛选房间；创建后立即进入新房间。
- 组织房间对全部有效组织成员开放（包括之后加入的成员，可查看全部历史）。私密房间只对创建时指定的成员开放。
- 成员私聊在组织内按双方成员 ID 和版本去重。个人私聊与另一个组织的私聊独立。对方离开/暂停后，留在组织的一方可看历史，不能继续发送。
- 退出、移除、暂停组织成员身份立即影响服务端权限；重新入组不会恢复旧私密房间或私聊资格。组织公开房间按当前有效成员身份访问。
- 成员、Agent、设置为次级功能入口。管理员添加自己拥有的 Agent 为一次操作，后端同一事务内验证所有权、组织管理权，并保留申请与批准审计。
- 无组织仍显示创建/加入引导；收到邀请需要本人接受，接受后回到工作区。组织、视图、会话保存在 URL，切换个人和 Team 保留各自最近位置。

参考飞书公开说明中的消息会话分组、会话内群设置与企业内公开群发现方式，复用这些导航原则，不复制其复杂应用套件：

- [飞书消息与群组入口](https://www.feishu.cn/content/article/7577674529519029437)
- [飞书公开群与可见性](https://www.feishu.cn/hc/zh-CN/articles/048084320256)

BotCord 本批组织房间允许全部有效成员访问，不提供飞书公开群那样额外的申请入群门槛。

## 数据与权限

新建 `team_conversations`、`team_conversation_members`、`team_messages`、`team_conversation_reads` 四张表，和旧 `Room`/`MessageRecord` 完全分离。复合外键约束会话、参与者、消息及已读状态属于同一空间。现有个人接口和 WebSocket 不会暴露这些表中的内容。

所有新接口使用 `require_user` 和 beta gate，不接受 Agent actor。每次读写检查组织状态、用户状态、当前成员资格和私密会话参与者版本。与成员撤销操作共享组织行锁，避免已撤权成员在另一个并发事务中继续写入。管理员角色、已保存的组织私聊政策均不跳过私聊参与者 ACL；额外内容审计仍无入口。

会话内 sequence 单调递增；`conversation_id + author_membership_id + client_id` 约束发送重试幂等，重复 ID 内容不一致返回冲突。已读序号只能前进且不超过最新消息。会话列表批量读取参与者、最新消息和未读，避免逐会话 N+1。

前端每个组织/会话独立状态实例。组织切换取消请求，旧响应不能覆盖新组织；历史分页和增量消息合并去重。授权复核失败清除旧内容。后台页面停止轮询，前台消息每 4 秒、会话列表每 8 秒刷新；当前是轮询同步，不声称 WebSocket 实时推送。

## API

基础路径 `/api/spaces/{space_id}/conversations`：

| 方法/路径 | 用途 |
| --- | --- |
| GET 基础路径 | 本人可访问的组织会话、最新消息预览、未读数、参与者和 can_send |
| POST 基础路径 | 创建 room/dm；kind、visibility、name、member_ids（组织成员关系 ID） |
| GET `/{id}/messages` | 最新 50 条；before 向前、after 增量，互斥；limit 1–100 |
| POST `/{id}/messages` | 成员文字消息，content 1–8000 字符，client_id UUID |
| PUT `/{id}/read` | 更新已读 sequence |

`GET /api/spaces` 新增 `organization_messaging_available`，组织返回 true；执行能力继续 false。旧 Hub 没有该标记时，前端保留成员管理入口，禁用建房和发起私聊。`agent_direct_admission_available` 独立标记原子添加 Agent 能力，旧 Hub 继续使用申请/批准两步流程。

`POST /api/spaces/{space_id}/agents/{agent_id}/admission/add` 供组织 owner/admin 原子添加自己拥有的 Agent，不能替其他所有者申请。

## 部署与当前边界

Hub 启动时已有 `Base.metadata.create_all`，会自动创建本批缺失的新表，因此现有预览部署可通过启动初始化完成建表；这不是现有列变更的通用迁移机制。需要显式管理数据库版本的环境使用以下流程：

1. 在配置的 Hub 数据 schema 下先应用 `backend/migrations/002_team_identity_spaces.sql`（若尚未应用），再应用 `003_team_conversations.sql`。
2. 部署 Hub，再部署 frontend。新表不迁移个人消息，不将旧多 Agent 编排归为组织任务。
3. 在独立 PostgreSQL 测试数据库验证实际迁移及并发撤权/发送，再上线。此次本地 SQLite 测试不能替代 PostgreSQL 多连接锁验证。

已实现的通信是**组织成员之间的文字交流**。Agent 团队消息/执行、附件、编辑/删除、房间成员后续变更、通知推送与私聊内容审计尚未实现。Agent 入组只建立成员身份，不会自动获得任务执行或私人资源访问授权。

## 验证

- `frontend: npm run build` 通过。迁移文件与四个模型及索引的 PostgreSQL DDL 编译输出一致。
- 前端全量 Vitest：270 passed（含并发撤权响应、历史合并、管理分区和旧 Hub 能力降级）。
- 后端全量：1616 passed、30 skipped、44 处既有警告；新增私聊离开只读行为后，Team 专项 24 passed。
- 本地浏览器验收用隔离测试数据加载实际组件：发送、私密建房、成员页、成员私聊、切换组织、手机返回列表、搜索、390px 无横向溢出均通过。
- 截图：[桌面消息](../frontend/docs/screenshots/team-workspace-desktop.png)、[创建房间](../frontend/docs/screenshots/team-workspace-create-room.png)、[移动端](../frontend/docs/screenshots/team-workspace-mobile.png)。截图为测试数据，非线上组织。
