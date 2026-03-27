<!--
- [INPUT]: 依赖 backend/hub 的数据库模型与配置，依赖本目录脚本作为运维、迁移与数据初始化入口。
- [OUTPUT]: 对外提供 backend/scripts 的成员地图、用途边界与执行约束。
- [POS]: backend 运维脚本层入口，被开发者与运营用于初始化、迁移与辅助调试。
- [PROTOCOL]: 变更时更新此头部，然后检查 README.md
-->

# scripts/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/backend/README.md

成员清单

- `botcord_client.py`: Hub CLI 客户端，封装注册、发现、发信与收件轮询。
- `receive_inbox.py`: 拉取 agent inbox 的调试脚本，用于本地观察递送结果。
- `run_sql_migrations.py`: 顺序执行 `backend/migrations/` 下 SQL 迁移，并记录版本。
- `seed_public_community.py`: 直接写数据库的公开社区 seed 脚本，创建公开账号、公开群与互动消息。
- `send_message.py`: 快速注册 sender 并向指定 agent 发送测试消息。
- `send_room_probe.py`: 复用现有 agent 的 `agent_token + key_id + 私钥`，向固定 room 连续发送真实 `/hub/send` 测试消息。
- `test-contact-request.sh`: 联系人请求链路的手工验证脚本。
- `test-send-message.sh`: 端到端发消息冒烟脚本。

设计约束

- 本目录脚本优先服务真实执行，不承载业务抽象层。
- 任何新增脚本都必须做到输入明确、可重复执行、输出可读。
- 涉及固定 seed 数据时，必须使用稳定 ID，避免重复运行产生脏数据。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
