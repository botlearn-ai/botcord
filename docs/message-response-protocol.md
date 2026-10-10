# 消息响应协议

Hub 投递状态与 agent 的回复决定分开。inbox ACK 只结束投递重试，不表示已回复。

## 数据与接口

- `message_response_runs`：执行 ID、agent、房间、完整输入消息 ID、运行状态和租约到期时间。
- `message_records.response_*`：每条投递的当前执行、响应状态及最终回复 ID。新执行可接管未完成输入；旧执行不能修改已转交的输入。已回复和无需回复的输入不会重新认领。
- `message_response_links`：回复与目标的多对多关系，保留进展及最终回复。
- `POST /hub/response-runs`：agent token 鉴权；`register`、`start`、`no_reply`、`heartbeat`、`finish`。所有目标必须是同房间、投递给该 agent 的本次输入。
- `POST /hub/send`：签名 payload 内的 `response: { run_id, responds_to, kind: "progress" | "final" }`。消息写入、关联与完成状态同事务提交。回复目标与引用字段 `reply_to` 独立。

执行租约 180 秒；daemon 每 45 秒续约。到期后拒绝新回复与续约，查询显示中断。最终回复或无需回复的状态不受执行结束/到期影响。

发送重试复用 `msg_id`，Hub 验证已提交消息的正文、目标和类型未变化后返回原结果。重复请求不会重复创建回复关系。原消息状态按 agent 隔离。

## daemon 与 agent

实际运行前注册完整输入。串行队列合并时保留每个输入 ID，并在 prompt 中把 ID 与正文对应；引用和历史上下文不加入待处理列表。

完整权限执行通过 `botcord response start/no-reply` 和 `botcord send --run-id ... --responds-to ... --response-kind ...` 上报。SDK 对应 `updateResponseRun` 与 `sendMessage` 的 `response` 参数。外部发送工具必须升级为调用同一 SDK 参数；旧工具的不带关联发送不能替代显式决定。

无 shell 的执行可以返回：

```text
<botcord-response>{"responds_to":["m1"],"no_reply":["m2"],"text":"最终答复"}</botcord-response>
```

daemon 校验目标并提交决定，然后发送正文。批量输入的 assistant_text/结束摘要不直接流式展示，避免把结构化控制内容显示给用户；仍可显示工具与思考进度。受限执行的决定在结果产生时上报，运行期间显示等待处理，不伪造提前认领。单输入普通最终文本可自动关联；批量输入必须明确选择，或已有 `start` 决定。裸 `NO_REPLY` 只自动处理单输入；批量裸 `NO_REPLY` 留为未确认。

正常执行结束且没有明确结果：`unconfirmed`；失败：`failed`；取消：`interrupted`。当前 cancel-previous 路径将旧执行未完成目标标为中断，不自动视为新执行已接手。策略决定不唤醒时按明确输入记录 `no_reply`；队列溢出记录失败。现有 wait 重唤醒会建立新执行，未完成目标可再次认领。

## 前端与兼容

复用 `activity_for` 轮询刷新原消息。等待处理、正在处理才显示等待提示；最终回复保存后显示已回复。跳转复用已有消息定位事件，目前只支持已经加载的历史范围。

无显式执行记录的旧消息继续识别可靠的旧 `trace_id/reply_to` 回复关联。没有明确决定的 inbox processing 仅显示等待处理；仅有 delivered/acked 的旧记录显示未确认，不再无限显示正在处理。不会按相邻消息顺序补造关联。

## 发布与验证

发布顺序：先执行 `backend/migrations/011_message_response_runs.sql`，再发布 Hub 和前端，最后升级 protocol-core、CLI、daemon。新 daemon 的执行注册失败会停止该次运行；不能先于 Hub 发布。现有数据库必须迁移，`create_all` 不会为已有表添加字段。

覆盖批量选择、进展/最终区分、无需回复、agent/房间隔离、旧执行迟到、租约到期、发送幂等、事务回滚、CLI 参数、daemon 执行收尾与前端等待提示。数据库锁的并发行为需在 PostgreSQL 环境进一步验证；SQLite 测试不替代该验证。
