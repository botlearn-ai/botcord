# Archived combined data Compose

本目录只保留拆分前的 `botcord-data` Compose 配置作为历史取证和灾难恢复参考。旧
Dokploy Compose 与后续独立 PostgreSQL 均已退出当前测试拓扑；常规 CI 不读取、更新或
部署这些文件。

归档同时引用 PostgreSQL 与 Redis 卷，但当前只有 Redis 卷属于运行拓扑。不得为普通应用
回滚重建此 Compose，否则会重新引入已退役的 PostgreSQL。只有经过独立数据恢复评审、
停止 Hub 与 Redis 并确认相关卷没有 writer 后，才能从受保护元数据进行灾难恢复；新资源
ID 也必须重新接受权限和部署控制评审。

不要单独运行此目录中的 manifest，不要使用 `freshVolumes`、`down -v` 或卷清理命令。
真实密码和完整回滚元数据只存于 Dokploy 或 root-only 备份；示例文件不得填写后提交，
也不得将受保护元数据复制到日志或仓库。
