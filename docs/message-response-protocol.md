# 消息响应协议

Hub 投递状态与 agent 的回复决定分开。inbox ACK 只结束投递重试，不表示已回复。

## 数据与接口

- `message_response_runs`：执行 ID、agent、房间、完整输入消息 ID、运行状态和租约到期时间。
- `message_records.response_*`：每条投递的当前执行、响应状态及最终回复 ID。新执行可接管未完成输入；旧执行不能修改已转交的输入。已回复和无需回复的输入不会重新认领。
- `message_response_links`：回复与目标的多对多关系，保留进展及最终回复。
- `POST /hub/response-runs`：agent token 鉴权；`queue`、`register`、`start`、`ignore`、`no_reply`、`replying`、`heartbeat`、`finish`。所有目标必须是同房间、投递给该 agent 的本次输入。
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

daemon 校验目标并提交决定，然后发送正文。批量输入的 assistant_text/结束摘要不直接流式展示，避免把结构化控制内容显示给用户；仍可显示工具与思考进度。批量受限执行的决定在结果产生时上报，运行期间不伪造提前认领；单输入自动回复路径由 daemon 在实际执行前声明 `start`。单输入普通最终文本可自动关联；批量输入必须明确选择，或已有 `start` 决定。裸 `NO_REPLY` 只自动处理单输入；批量裸 `NO_REPLY` 留为未确认。

正常执行结束且没有明确结果：`unconfirmed`；失败：`failed`；取消：`interrupted`。当前 cancel-previous 路径将旧执行未完成目标标为中断，不自动视为新执行已接手。策略决定不唤醒时按明确输入记录 `ignored`（兼容字段仍为 `no_reply`）；队列溢出记录失败。现有 wait 重唤醒会建立新执行，未完成目标可再次认领。

## 前端与兼容

复用 `activity_for` 轮询刷新原消息。等待处理、正在处理才显示等待提示；最终回复保存后显示已回复。跳转复用已有消息定位事件，目前只支持已经加载的历史范围。

无显式执行记录的旧消息继续识别可靠的旧 `trace_id/reply_to` 回复关联。没有明确决定的 inbox processing 仅显示等待处理；仅有 delivered/acked 的旧记录显示未确认，不再无限显示正在处理。不会按相邻消息顺序补造关联。

## 发布与验证

发布顺序：先执行 `backend/migrations/011_message_response_runs.sql` 和 `backend/migrations/015_message_response_states.sql`，再发布 Hub 和前端，最后升级 protocol-core、CLI、daemon。新 daemon 的执行注册失败会停止该次运行；不能先于 Hub 发布。现有数据库必须迁移，`create_all` 不会为已有表添加字段。

覆盖批量选择、进展/最终区分、无需回复、agent/房间隔离、旧执行迟到、租约到期、发送幂等、事务回滚、CLI 参数、daemon 执行收尾与前端等待提示。新增 PostgreSQL 集成测试验证迁移重入、并发上报幂等及过期 ORM 缓存刷新；SQLite 测试不替代该验证。

## 持久化状态事实（015 数据层）

此阶段只补数据与上报，不改变 `reply_activity` 投影或前端展示。迁移
`015_message_response_states.sql` 必须先于新 Hub 发布；新 daemon/CLI 必须在
Hub 升级后发布。旧客户端可以继续调用原有动作。

`message_records` 新增：

- `response_state`：当前明确上报的处理状态。
- `response_reason`：有限枚举原因，不存原始异常、消息正文或凭据。
- `response_updated_at`：Hub 接受当前状态的时间。

| 状态 | 事实来源 |
| --- | --- |
| `queued` | daemon 已通过唤醒规则，接受到执行队列；尚未调用运行时 |
| `waiting` | 已注册本次执行的完整输入，尚未明确选择该输入 |
| `processing` | 明确选择输入并开始处理；单输入自动回复路径可由 daemon 上报 |
| `ignored` | 未开始处理，策略明确决定跳过；不得从 processing/replying 转入 |
| `no_reply` | 明确决定无需回复；新 daemon/CLI 用 agent_decision 说明执行后的决定 |
| `replying` | 明确上报开始发送，或已保存关联的进展回复；不等于最终回复成功 |
| `completed` | 最终回复与输入关联成功，和消息/关联在同一事务内保存 |
| `failed` | 执行、队列溢出、决定解析或回复发送失败 |
| `interrupted` | 取消、被替代或排队后未执行 |
| `unconfirmed` | 执行结束，但没有明确结果 |

`message_response_events` 追加记录每个“输入消息 × Agent × 执行”的状态变化，
包含 run_id、目标消息 ID、Agent、房间、状态、原因、回复 ID 和服务端时间。
每个执行中同一输入的同一状态最多一条，重复上报不增加事件，迟到的 start
不能把 replying 降回 processing。每次重试使用新 run_id，因此旧尝试保留在
事件记录中。查询可按 `(room_id, target_msg_id, agent_id, id)` 排序。
心跳只更新租约，不追加状态事件。

兼容字段 `response_status` 仍写旧词汇：ignored → no_reply，replying → processing；
queued 不写旧响应状态，防止旧消费者将排队租约误判成运行结果。旧的
waiting/processing/completed 等保持不变。历史行的新字段保持 NULL；不把旧
no_reply 推断为 ignored，也不补造历史事件。

新增动作：

- `queue`：持久化输入排队与执行租约，运行状态为 queued；排队期间续约。
- `register`：可把 queued 执行提升为 running。此时允许按实际批次确定输入；
  从该执行批次剔除的输入记 failed/batch_trimmed。开始运行后输入集合不可变。
- `ignore`：明确跳过，策略使用 reason=attention_policy。
- `replying`：上报选定输入的回复发送意图；SDK、CLI 都支持。
- 现有 `no_reply`、`finish` 支持枚举 reason。无法确定来源的旧上报可以不传原因。

串行合并将输入交给最终执行；原排队执行收尾使用 finish/only_if_queued，只能结束仍在 queued 的执行，
并修改仍属于自己的未完成输入；不能覆盖已经开始运行的真实结果。
新排队不能抢占尚有效的运行执行，但可恢复租约已过期或已经结束的未解决输入。
completed/no_reply/ignored 不会被新执行重新认领。队列登记或策略跳过上报失败时
不确认该次入站，交给投递重试；异常退出仍以租约事实供后续投影判断，不补造结果。
附件等待后续文本的既有延迟缓冲不新增状态，合并进入实际执行后按同一输入协议记录。

数据库没有完整历史事实的旧消息保持未知。租约过期的“中断”仍由后续投影计算，
事件记录不会把没有上报的终态伪装成 Agent 的决定。

验证包括 SQLite 状态与事务测试，以及可选真实 PostgreSQL 测试：

```bash
cd backend
RESPONSE_STATE_TEST_DATABASE_URL=postgresql+asyncpg://... \
  uv run pytest tests/test_message_response_states_postgres.py -q
```

PostgreSQL 测试使用独立随机 schema，验证 015 迁移重复执行、旧数据保持不变、
并发首次登记及状态上报幂等。运行结束删除该测试 schema。

## 消息状态投影

消息查询的 `reply_activity` 和增量轮询的 `activity_updates` 使用同一只读投影。
每个实际投递到的 Agent 返回一条记录，覆盖未 @ 的群消息及 Agent 发出的消息；
不为没有收到消息的房间成员补造状态。撤回消息、自投递（owner chat 除外）和人类接收者不返回记录。
现有房间成员权限检查保持不变，公开访客不能读取投影。

新增字段：

- `response_state`：供新版 reaction 使用的精确状态，包含 015 的十种状态及 `unknown`。
- `reason`：允许列表内的上报原因，或投影原因 `lease_expired`、`run_missing`、`inconsistent_run`、`missing_decision`。不透传异常文本。
- `derived`：是否根据租约或旧回复证据推导，而非直接使用状态事实。
- `updated_at`：最后一次明确状态上报时间（UTC）；不是轮询时间，也不伪造超时事件时间。

读取当前 `response_run_id` 对应的执行，历史尝试和迟到回复不覆盖当前快照。
活动状态 queued/waiting/processing/replying 在有效执行中保持原值；执行租约过期投影为
interrupted/lease_expired。缺少执行、执行归属不符、输入不在批次、执行已结束却没有终态，
或排队/执行阶段不一致时投影为 unconfirmed。明确终态不受租约影响。
查询不会更新快照、续约或追加事件；执行事件历史保留用于审计，不在每次消息查询时重放。

历史没有明确响应事实时返回 unknown；旧 no_reply 无法区别策略忽略和执行后的决定，
也返回 unknown。旧版带 trace/reply_to 的实际回复仍可作为完成证据，trace 优先；
显式 response 元数据的引用不参与旧版猜测。投递 ACK、done、processing 均不证明思考或回复。

`status` 继续为旧界面保留兼容词汇：queued → waiting，ignored → no_reply，
replying → processing。旧数据保留旧界面既有行为；新 UI 必须优先读 `response_state`，
不要从兼容 `status` 推断忽略/无需回复，也不要用在线状态替代消息处理状态。
本阶段只同步前端类型，reaction 的生产组件等待静态方案选定后实现。
