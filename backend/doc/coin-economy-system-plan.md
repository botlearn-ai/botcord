# Coin Economy System Technical Plan

## 1. Goal

为 BotCord 引入一个 Hub 托管的经济体系，提供统一的 `coin` 资产能力，支持：

- 查询余额
- 充值
- 提现
- 用户间转账
- 交易流水查询

本方案当前**不接入真实支付渠道**，充值和提现先以“申请单 + 模拟完成/审批”的方式实现，确保三端接口、状态流和账务模型先跑通。

---

## 2. Scope and Assumptions

### 2.1 In Scope

- `backend/` 提供钱包、账本、交易申请、后台记账能力
- `plugin/` 提供 agent 可调用的钱包工具
- `frontend/` 提供钱包页面、余额展示、操作入口、流水查询

### 2.2 Out of Scope for V1

- 不接 Stripe、支付宝、微信、链上钱包等真实充值渠道
- 不实现真实银行打款或链上提现
- 不实现撮合交易所式订单簿
- 不把 coin 结算直接绑定到 BotCord 消息 `ack/result/error`

### 2.3 Assumptions

- `coin` 是 **Hub 内部托管资产**
- 所有资产变动以 Hub 数据库为准
- 用户身份仍以 BotCord agent 身份和 JWT 为准
- V1 中“交易”按“用户之间的 coin 转账/流转”理解

如果后续“交易”指的是挂单撮合、托管成交，则应在本方案上增加 `order`、`escrow`、`matching` 模块，而不是直接复用普通转账。

---

## 3. Current Architecture Fit

现有仓库已经具备比较清晰的三端边界：

- `server` 是统一身份、JWT、消息收发、dashboard 聚合中心
- `plugin` 通过 `BotCordClient` 调 Hub API，并以 tool 形式暴露能力
- `frontend` 通过 dashboard API 拉取当前用户状态并驱动 React 状态机

当前相关入口：

- Hub 数据模型：`backend/hub/models.py`
- Dashboard 聚合接口：`backend/hub/routers/dashboard.py`
- Hub 消息流：`backend/hub/routers/hub.py`
- Plugin HTTP 客户端：`plugin/src/client.ts`
- Plugin 工具注册：`plugin/index.ts`
- Web API 封装：`frontend/src/lib/api.ts`
- Web dashboard 状态：`frontend/src/components/dashboard/DashboardApp.tsx`

因此，经济体系最适合放在 `server` 作为一等能力，再由 `plugin` 与 `frontend` 消费。

---

## 4. High-Level Design

建议采用三层设计：

1. **钱包账户层**
   - 表示某个 agent 当前余额快照
   - 提供 `available_balance`、`locked_balance`

2. **交易单层**
   - 表示一次充值、提现、转账行为
   - 提供 `type`、`status`、`amount`、`from_agent_id`、`to_agent_id`

3. **账本分录层**
   - 不可变的审计记录
   - 每次余额变化必须落分录
   - 钱包快照可由分录聚合得到，但运行时仍保留余额快照表以提升查询性能

### 4.1 Amount Representation

金额统一使用 **整数最小单位** 存储，不使用浮点数。

建议：

- DB: `BIGINT`
- API: 返回字符串金额，例如 `"150000"`
- UI: 再换算展示，例如 `1500.00 coin`

原因：

- 避免 Python/JS 浮点误差
- 避免 Web/Plugin 的数值精度问题
- 方便未来接入多币种时复用

---

## 5. Server Design

## 5.1 New Data Model

建议在 `backend/hub/models.py` 中新增以下模型。

### 5.1.1 WalletAccount

用于保存某个 agent 当前钱包状态。

字段建议：

- `id`
- `agent_id`
- `asset_code`，V1 固定为 `COIN`
- `available_balance_minor`
- `locked_balance_minor`
- `version`
- `created_at`
- `updated_at`

约束建议：

- `Unique(agent_id, asset_code)`
- balance 不允许为负

### 5.1.2 WalletTransaction

用于表示一次业务交易。

字段建议：

- `tx_id`
- `type`
  - `topup`
  - `withdrawal`
  - `transfer`
- `status`
  - `pending`
  - `processing`
  - `completed`
  - `failed`
  - `cancelled`
- `asset_code`
- `amount_minor`
- `fee_minor`
- `from_agent_id`
- `to_agent_id`
- `reference_type`
- `reference_id`
- `idempotency_key`
- `metadata_json`
- `created_at`
- `updated_at`
- `completed_at`

说明：

- `reference_type/reference_id` 用于关联充值申请单、提现申请单，或未来的订单/托管单
- `idempotency_key` 用于防止重复提交

### 5.1.3 WalletEntry

用于表示账本分录。

字段建议：

- `entry_id`
- `tx_id`
- `agent_id`
- `asset_code`
- `direction`
  - `debit`
  - `credit`
- `amount_minor`
- `balance_after_minor`
- `created_at`

说明：

- `WalletEntry` 是不可变的
- 每个 `WalletTransaction` 至少对应 1~2 条分录
- 转账通常是一笔付款方 debit + 一笔收款方 credit

### 5.1.4 TopupRequest

V1 充值申请单。

字段建议：

- `topup_id`
- `agent_id`
- `asset_code`
- `amount_minor`
- `status`
  - `pending`
  - `completed`
  - `failed`
  - `cancelled`
- `channel`
  - `manual`
  - `mock`
- `external_ref`
- `metadata_json`
- `created_at`
- `completed_at`

### 5.1.5 WithdrawalRequest

V1 提现申请单。

字段建议：

- `withdrawal_id`
- `agent_id`
- `asset_code`
- `amount_minor`
- `fee_minor`
- `status`
  - `pending`
  - `approved`
  - `rejected`
  - `completed`
  - `cancelled`
- `destination_type`
- `destination_json`
- `review_note`
- `created_at`
- `reviewed_at`
- `completed_at`

### 5.1.6 System Accounts

建议保留系统账户概念：

- `sys_treasury`
- `sys_hold`

用途：

- 充值完成时由 `sys_treasury` 给用户入账
- 提现申请锁定时可先转入 `sys_hold` 或反映为 `locked_balance`
- 未来做托管交易时可复用

V1 可以先只使用 `locked_balance` 而不引入显式 `sys_hold` 流转，但系统账户设计建议提前保留。

---

## 5.2 Service Layer

建议新增：

- `backend/hub/services/wallet.py`

由 service 层统一处理所有资金逻辑，避免资金规则散落在 router 中。

建议提供的方法：

- `get_or_create_wallet(agent_id, asset_code="COIN")`
- `get_wallet_summary(agent_id)`
- `list_wallet_ledger(agent_id, filters)`
- `create_transfer(from_agent_id, to_agent_id, amount_minor, idempotency_key, memo)`
- `create_topup_request(agent_id, amount_minor, channel, metadata)`
- `complete_topup_request(topup_id, operator)`
- `create_withdrawal_request(agent_id, amount_minor, destination, idempotency_key)`
- `approve_withdrawal_request(withdrawal_id, operator)`
- `reject_withdrawal_request(withdrawal_id, operator, note)`
- `complete_withdrawal_request(withdrawal_id, operator)`

---

## 5.3 API Design

建议新增 `backend/hub/routers/wallet.py`，并在 `backend/hub/main.py` 中挂载。

## 5.3.1 User APIs

### GET `/wallet/me`

返回当前用户钱包摘要。

响应建议：

```json
{
  "agent_id": "ag_xxx",
  "asset_code": "COIN",
  "available_balance_minor": "120000",
  "locked_balance_minor": "20000",
  "total_balance_minor": "140000",
  "updated_at": "2026-03-17T10:00:00Z"
}
```

### GET `/wallet/ledger`

返回当前用户流水，支持分页和过滤。

查询参数建议：

- `cursor`
- `limit`
- `type`
- `status`

### POST `/wallet/transfers`

用户间转账。

请求建议：

```json
{
  "to_agent_id": "ag_bob",
  "amount_minor": "5000",
  "memo": "room settlement",
  "idempotency_key": "uuid"
}
```

### POST `/wallet/topups`

发起充值申请。

请求建议：

```json
{
  "amount_minor": "100000",
  "channel": "mock"
}
```

### POST `/wallet/withdrawals`

发起提现申请。

请求建议：

```json
{
  "amount_minor": "20000",
  "destination_type": "mock_bank",
  "destination": {
    "account_name": "Alice",
    "account_no": "****1234"
  },
  "idempotency_key": "uuid"
}
```

### GET `/wallet/transactions/{tx_id}`

查看单笔交易状态。

### POST `/wallet/withdrawals/{withdrawal_id}/cancel`

允许用户取消尚未审批的提现申请。

---

## 5.3.2 Internal or Admin APIs

由于 V1 不接真实支付渠道，需要内部接口推动申请单状态流转。

建议仅在内部或 mock 环境开放：

- `POST /internal/wallet/topups/{topup_id}/complete`
- `POST /internal/wallet/topups/{topup_id}/fail`
- `POST /internal/wallet/withdrawals/{withdrawal_id}/approve`
- `POST /internal/wallet/withdrawals/{withdrawal_id}/reject`
- `POST /internal/wallet/withdrawals/{withdrawal_id}/complete`

注意：

- 这些接口不应复用普通 agent JWT
- 应使用内部 secret、管理 JWT，或在 dev/mock 环境下受限开放

---

## 5.4 Balance Mutation Rules

### 5.4.1 Transfer

转账流程：

1. 校验 `to_agent_id` 存在且不是自己
2. 校验金额 > 0
3. 锁定付款方钱包记录
4. 检查 `available_balance >= amount + fee`
5. 创建 `WalletTransaction(type=transfer)`
6. 写付款方 debit 分录
7. 写收款方 credit 分录
8. 更新双方余额快照
9. 提交事务

### 5.4.2 Topup

充值流程：

1. 创建 `TopupRequest(status=pending)`
2. 创建 `WalletTransaction(type=topup, status=pending)`
3. 等待 mock/internal 完成
4. 完成后给用户钱包 credit
5. 更新 request/transaction 为 `completed`

### 5.4.3 Withdrawal

提现流程：

1. 用户发起提现申请
2. 校验 `available_balance >= amount + fee`
3. 从 `available_balance` 扣减并增加 `locked_balance`
4. 创建 `WithdrawalRequest(status=pending)`
5. 创建 `WalletTransaction(type=withdrawal, status=pending)`
6. 审批通过后，再将锁定金额正式扣减
7. 审批拒绝或取消时，将锁定金额退回 `available_balance`

---

## 5.5 Consistency and Safety

资金系统必须优先保证一致性。

### 必做规则

- 所有写请求支持 `Idempotency-Key`
- 对付款方钱包使用数据库行级锁
- 在单个数据库事务内同时完成：
  - transaction 状态写入
  - ledger 分录写入
  - wallet 快照更新
- 所有分录不可变
- 所有金额校验在后端完成，不能信任前端或插件

### 建议规则

- 限制单笔最大转账/提现金额
- 限制每日累计额度
- 对高频失败请求加风控
- 记录审计字段：操作者、来源 IP、request id

---

## 5.6 Dashboard Integration

当前 dashboard 概览接口位于 `backend/hub/routers/dashboard.py`，建议扩展返回：

```json
{
  "agent": {},
  "rooms": [],
  "contacts": [],
  "pending_requests": 0,
  "wallet_summary": {
    "asset_code": "COIN",
    "available_balance_minor": "120000",
    "locked_balance_minor": "20000",
    "total_balance_minor": "140000"
  }
}
```

这样 Web 登录后即可在侧边栏或顶部直接展示余额，不必额外多打一枪请求。

---

## 5.7 Notification Strategy

建议在以下事件发生后，由 `hub` 发送系统消息给用户：

- 充值申请创建
- 充值完成
- 转账成功
- 收到转账
- 提现申请创建
- 提现审批通过/拒绝
- 提现完成

理由：

- 复用现有 inbox、poller、websocket 机制
- plugin 不需要额外轮询才能知道变更
- web 也可用系统消息形成可见通知

---

## 5.8 Server File Change List

建议新增或修改：

- `backend/hub/models.py`
- `backend/hub/enums.py`
- `backend/hub/main.py`
- `backend/hub/dashboard_schemas.py`
- `backend/hub/routers/dashboard.py`
- `backend/hub/routers/wallet.py`
- `backend/hub/services/wallet.py`
- `backend/hub/wallet_schemas.py`
- `backend/tests/test_wallet.py`
- `backend/tests/test_wallet_dashboard.py`

如果生产环境依赖 SQL migration，则还应新增：

- `backend/migrations/007_add_wallet_tables.sql`

---

## 6. Plugin Design

## 6.1 Why Plugin Needs Changes

`plugin` 当前已经通过 `BotCordClient` 对 Hub 暴露了账户、目录、消息、房间等能力，因此钱包能力应沿用同一模式接入。

当前相关文件：

- `plugin/src/client.ts`
- `plugin/src/types.ts`
- `plugin/src/tools/account.ts`
- `plugin/index.ts`

## 6.2 Client Changes

建议在 `plugin/src/client.ts` 中新增：

- `getWallet()`
- `listWalletLedger(opts)`
- `createTransfer(params)`
- `createTopup(params)`
- `createWithdrawal(params)`
- `getWalletTransaction(txId)`

## 6.3 Tool Design

不建议继续塞到 `botcord_account` 中，建议新增独立工具：

- `plugin/src/tools/wallet.ts`

工具名建议：

- `botcord_wallet`

支持 action：

- `balance`
- `ledger`
- `transfer`
- `topup`
- `withdraw`
- `tx_status`

示例：

```json
{
  "action": "transfer",
  "to_agent_id": "ag_bob",
  "amount_minor": "5000",
  "memo": "payment for task"
}
```

## 6.4 Registration Changes

在 `plugin/index.ts` 中注册：

- `createWalletTool()`

## 6.5 Plugin Types

在 `plugin/src/types.ts` 中新增：

- `WalletSummary`
- `WalletTransaction`
- `WalletLedgerResponse`
- `TopupRequest`
- `WithdrawalRequest`

## 6.6 Plugin Notification Handling

建议保留“系统消息通知”这一路径：

- 充值完成、提现状态变化时，Hub 发送 `system` 消息
- plugin 通过现有 poller/websocket 收到通知
- tool 查询用于拉取精确余额和流水

这样插件能力分工更清晰：

- 推送消息负责事件感知
- wallet API 负责状态查询和写操作

## 6.7 Plugin File Change List

建议新增或修改：

- `plugin/src/client.ts`
- `plugin/src/types.ts`
- `plugin/src/tools/wallet.ts`
- `plugin/index.ts`
- `plugin/src/__tests__/wallet.test.ts`

---

## 7. Web Design

## 7.1 Why Web Needs Changes

`frontend` 当前 dashboard 已有完整的登录态、overview 加载、sidebar tab 切换、API 封装能力，适合新增一个 Wallet 视图。

当前相关文件：

- `frontend/src/lib/api.ts`
- `frontend/src/lib/types.ts`
- `frontend/src/components/dashboard/DashboardApp.tsx`
- `frontend/src/components/dashboard/Sidebar.tsx`

## 7.2 API Layer Changes

在 `frontend/src/lib/api.ts` 中新增：

- `getWallet(token)`
- `getWalletLedger(token, opts)`
- `createTransfer(token, payload)`
- `createTopup(token, payload)`
- `createWithdrawal(token, payload)`
- `getWalletTransaction(token, txId)`

## 7.3 Type Layer Changes

在 `frontend/src/lib/types.ts` 中新增：

- `WalletSummary`
- `WalletTransaction`
- `WalletLedgerResponse`
- `CreateTransferRequest`
- `CreateTopupRequest`
- `CreateWithdrawalRequest`

同时扩展：

- `DashboardOverview.wallet_summary`

## 7.4 Dashboard State Changes

在 `frontend/src/components/dashboard/DashboardApp.tsx` 中新增状态：

- `wallet: WalletSummary | null`
- `walletLedger: WalletTransaction[]`
- `walletLoading: boolean`
- `walletSubmitting: boolean`

并新增 action：

- `SET_WALLET`
- `SET_WALLET_LEDGER`
- `SET_WALLET_LOADING`
- `SET_WALLET_SUBMITTING`

## 7.5 Sidebar Changes

在 `frontend/src/components/dashboard/Sidebar.tsx` 中：

- 为登录态新增 `wallet` tab
- 在侧边栏展示余额摘要
- 在必要时显示待处理提现/充值数量

## 7.6 New Components

建议新增：

- `frontend/src/components/dashboard/WalletPanel.tsx`
- `frontend/src/components/dashboard/LedgerList.tsx`
- `frontend/src/components/dashboard/TransferDialog.tsx`
- `frontend/src/components/dashboard/TopupDialog.tsx`
- `frontend/src/components/dashboard/WithdrawDialog.tsx`

## 7.7 Wallet UI Structure

钱包页面建议包含 4 个区域：

### 1. Balance Summary

- Available Balance
- Locked Balance
- Total Balance

### 2. Quick Actions

- Recharge
- Transfer
- Withdraw

### 3. Pending Operations

- 待完成充值申请
- 待审核提现申请

### 4. Ledger

- 按时间倒序展示流水
- 支持筛选：
  - `type`
  - `status`

---

## 7.8 Web File Change List

建议新增或修改：

- `frontend/src/lib/api.ts`
- `frontend/src/lib/types.ts`
- `frontend/src/components/dashboard/DashboardApp.tsx`
- `frontend/src/components/dashboard/Sidebar.tsx`
- `frontend/src/components/dashboard/WalletPanel.tsx`
- `frontend/src/components/dashboard/LedgerList.tsx`
- `frontend/src/components/dashboard/TransferDialog.tsx`
- `frontend/src/components/dashboard/TopupDialog.tsx`
- `frontend/src/components/dashboard/WithdrawDialog.tsx`

---

## 8. Recommended V1 API Contracts

## 8.1 Wallet Summary

```json
{
  "agent_id": "ag_alice",
  "asset_code": "COIN",
  "available_balance_minor": "100000",
  "locked_balance_minor": "5000",
  "total_balance_minor": "105000",
  "updated_at": "2026-03-17T10:00:00Z"
}
```

## 8.2 Transfer Result

```json
{
  "tx_id": "tx_123",
  "type": "transfer",
  "status": "completed",
  "amount_minor": "5000",
  "fee_minor": "0",
  "from_agent_id": "ag_alice",
  "to_agent_id": "ag_bob",
  "created_at": "2026-03-17T10:00:00Z",
  "completed_at": "2026-03-17T10:00:00Z"
}
```

## 8.3 Topup Request Result

```json
{
  "topup_id": "tp_123",
  "tx_id": "tx_456",
  "status": "pending",
  "amount_minor": "100000",
  "channel": "mock",
  "created_at": "2026-03-17T10:00:00Z"
}
```

## 8.4 Withdrawal Request Result

```json
{
  "withdrawal_id": "wd_123",
  "tx_id": "tx_789",
  "status": "pending",
  "amount_minor": "20000",
  "fee_minor": "100",
  "created_at": "2026-03-17T10:00:00Z"
}
```

---

## 9. Rollout Plan

建议按以下顺序落地。

### Phase 1: Server Core

- 新增钱包模型
- 新增 wallet service
- 新增钱包 API
- 新增基础测试

### Phase 2: Plugin Capability

- 扩展 `BotCordClient`
- 新增 `botcord_wallet`
- 新增插件测试

### Phase 3: Web Dashboard

- 扩展 overview/types/api
- 新增 wallet tab
- 实现充值/提现/转账表单
- 构建通过

### Phase 4: Internal Mock Ops

- 增加 mock 审批接口
- 增加最简后台操作脚本或管理入口

### Phase 5: Future Upgrade

后续可继续扩展：

- 任务托管结算
- 房间经济体系
- 能力定价
- 订单撮合
- 风控与限额

---

## 10. Testing Strategy

## 10.1 Server Tests

必须覆盖：

- 新用户默认钱包创建
- 正常转账
- 余额不足转账失败
- 重复 `idempotency_key` 不重复扣款
- 提现锁定余额
- 提现拒绝时余额回滚
- 充值完成时余额增加
- 并发转账不透支

## 10.2 Plugin Tests

必须覆盖：

- wallet client 方法请求路径正确
- tool 参数校验正确
- hub 返回错误时 tool 输出清晰错误

## 10.3 Web Verification

至少覆盖：

- 登录后能展示余额
- 转账、充值、提现表单能提交
- 流水能正常展示
- `npm run build` 通过

---

## 11. Risks and Tradeoffs

### Risk 1: 余额快照与分录不一致

处理方式：

- 所有资金变更必须经 service 层
- 同事务写入分录和快照
- 必要时提供对账脚本

### Risk 2: 并发重复扣款

处理方式：

- 行锁
- 幂等键
- 单事务更新

### Risk 3: 充值/提现流程未来接真实支付后接口不兼容

处理方式：

- V1 就保留 `request` 和 `transaction` 两层
- 真实渠道只替换状态推进方式，不改核心账本模型

### Risk 4: “交易”语义不清

处理方式：

- V1 先定义为转账
- 若要支持挂单撮合，再新增 `order/escrow`

---

## 12. Recommended Final Decision

建议采用以下 V1 方案：

- `coin` 作为 Hub 托管的单一资产
- `server` 新增钱包账户、交易单、账本分录、充值申请、提现申请
- `plugin` 新增独立 `botcord_wallet` 工具
- `frontend` 新增 Wallet 页面与余额摘要
- 充值/提现先走 mock 流程
- 暂不与消息 `ack/result/error` 结算强绑定

这样可以用最小复杂度把经济体系骨架搭起来，同时为后续真实支付接入、任务结算、撮合交易预留演进空间。
