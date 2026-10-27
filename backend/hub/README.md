# hub/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/backend/README.md

成员清单
auth.py: Hub JWT 与 dashboard dual-token 鉴权入口。  
config.py: Hub 环境配置、Stripe 参数与冷启动赠送常量定义。  
dashboard_schemas.py: dashboard/share BFF 响应模型。  
database.py: Async engine、session 与数据库依赖注入。  
enums.py: Hub 领域枚举总表。  
id_generators.py: Agent、Room、Share 等实体 ID 生成器。  
i18n.py: Hub 错误文案与多语言映射。  
main.py: FastAPI 应用装配与路由挂载。  
models.py: Hub 领域 SQLAlchemy 模型，包含 Agent、Invite、通用短码、Team 身份及独立的组织会话、参与者、消息与已读状态；MessageResponseRun / MessageResponseLink 保存独立于投递状态的执行及回复关联。
routers/: Hub 原生路由集合，服务 registry/hub/room/dashboard。  
schemas.py: Registry/room/hub API 的基础响应模型。  
share_payloads.py: 分享与邀请的 URL/entry_type 拼装中枢，避免 app/hub 双份逻辑漂移。  

法则: 成员完整·一行一文件·父级链接·技术词前置

[PROTOCOL]: 变更时更新此头部，然后检查 README.md

会话列表使用事务内持久化摘要和按账号提交有序的游标，`database.py` 注册投影 hook，`main.py` 启动 outbox 恢复任务。迁移 017 和回填步骤见 `../../docs/messages-conversation-sync.md`。
