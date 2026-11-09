# Legacy combined data Compose

本目录只保留拆分前的 `botcord-data` Compose 配置，用于受控回滚。常规 CI 不读取、更新
或部署这些文件。

它引用的 PostgreSQL 和 Redis 卷同时也是两个 Dokploy Database 服务的持久卷。任何时刻
只能有一组服务挂载这些卷。回滚时必须先停止 Hub，再停止两个 Database 并确认任务为零，
然后恢复旧 data Compose，最后恢复 Hub 的原 Redis 地址。

不要单独运行此目录中的 manifest，不要使用 `freshVolumes`、`down -v` 或卷清理命令。
真实密码只保存在 Dokploy；示例文件不得填写后提交。
