# Legacy combined data Compose

本目录只保留拆分前的 `botcord-data` Compose 配置，用于受控重建和回滚。旧 Dokploy
Compose 资源已经删除，常规 CI 不读取、更新或部署这些文件。

它引用的 PostgreSQL 和 Redis 卷同时也是两个 Dokploy Database 服务的持久卷。任何时刻
只能有一组服务挂载这些卷。回滚时必须先停止 Hub，再停止两个 Database 并确认任务为零，
然后使用远端受保护的元数据重建原 appName 和卷挂载，最后恢复 Hub 的原 Redis 地址。
Dokploy 会为重建资源生成新 ID；如需恢复旧部署流程，必须同步更新 CI member 权限和控制
代码中的资源 ID。

不要单独运行此目录中的 manifest，不要使用 `freshVolumes`、`down -v` 或卷清理命令。
真实密码和完整回滚元数据只存于 Dokploy 或 root-only 备份；示例文件不得填写后提交，
也不得将受保护元数据复制到日志或仓库。
