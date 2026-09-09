# team/

`TeamWorkspacePage.tsx` 是 `/chats/team` 的组织工作区：组织切换和功能导航、会话列表、消息内容三栏。默认进入消息，房间是会话列表的筛选视图；成员、Agent、设置为独立页面。URL 记录 `space`、`view` 和 `conversation`，初次进入后补齐组织 ID。切换组织销毁旧会话状态，切换个人/Team 保留两边最近地址。

`TeamThread.tsx` 提供成员文字消息、发送失败保留草稿、历史分页、详情和已读标记。发送使用客户端 UUID 幂等重试，后台消息按 sequence 增量拉取，合并并发历史请求；可见页面每 4 秒更新消息、每 8 秒更新会话列表。私聊对方退出/暂停后保留历史并停止发送。`store/team-thread-store.ts` 隔离请求代际，授权复核失败立即清空历史。Team 不使用个人 Room、消息缓存或 Agent 身份。

`TeamConversationDialog.tsx` 使用原生模态框的焦点约束和 Escape 关闭行为，创建组织公开房间、指定成员私密房间或一对一成员私聊。组织公开房间的全部历史对当前和之后加入的有效成员可见；私密会话仅对创建时选定的有效成员版本可见。

`TeamSpacesPage.tsx` 保留 `/settings/spaces` 的治理页面及无组织/待接受邀请引导。工作区通过 `section` 仅嵌入成员、Agent 或设置之一。现有 API 支持邀请、接受、退出/移除、Agent 申请/审批和政策设置。组织管理员添加自己拥有的 Agent 调用原子的 `/admission/add`；其他成员仍申请后由管理员批准。

`TeamWorkspaceSkeleton.tsx` 与消息工作区三栏形态保持一致，供首次加载、鉴权等待使用。

`organization_messaging_available` 控制旧 Hub 的兼容降级。成员文字交流和 Agent 执行是独立能力：Agent 可以加入组织，但尚不能参与团队对话、执行任务；不能以入组成功暗示其已可执行。

测试包括页面结构、旧 Hub 降级、路由、API 用户身份及异步历史合并/取消/撤权。本地隔离测试数据的桌面、移动端与建房截图在 `frontend/docs/screenshots/team-workspace-*.png`；后端真实鉴权与数据库测试另见共享文档 [Team 工作区](../../../../docs/team-workspace-messaging.md)。
