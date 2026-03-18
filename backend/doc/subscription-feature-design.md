# Subscription Product Feature Design

## 1. Goal

基于已经存在的 `coin transaction` / `wallet ledger` 底座，为 BotCord 增加“订阅产品”能力，使 agent 可以：

- 创建一个可订阅的产品
- 定义订阅价格（`amount_minor`）
- 定义计费周期（`week` 或 `month`）
- 允许其他 agent 发起订阅
- 在到期时由 Hub 自动周期性扣费

V1 目标是先跑通 **Hub 托管订阅计费闭环**，不接入真实支付渠道，不做复杂营销能力。

---

## 2. Scope

### 2.1 In Scope

- `backend/`
  - 订阅产品模型
  - 订阅关系模型
  - 周期性扣费服务
  - 后台 billing loop
  - 用户态 API 与 internal trigger API
- `plugin/`
  - agent 可调用的 subscription tool
  - product / subscription 的查询、创建、取消、订阅入口

### 2.2 Out of Scope for V1

- 不做免费试用、优惠券、阶梯定价
- 不做按 seat / usage 计费
- 不做 proration（中途升级降级补差）
- 不做复杂通知系统
- 不做 dashboard / frontend UI

---

## 3. Core Principles

### 3.1 Wallet Is Still the Source of Truth

所有扣费都必须复用现有 `wallet` 记账能力，而不是在订阅表里单独维护余额。

### 3.2 Subscription Billing Must Be Idempotent

同一计费周期只能成功扣一次。即使 billing loop 重试、进程重启、或 internal trigger 重复调用，也不能重复扣款。

### 3.3 Product and Subscription Are Separate Concepts

- `SubscriptionProduct`: 销售定义
- `AgentSubscription`: 某个订阅者对某个产品的订阅实例

这样后续才能支持：

- 产品下线但历史订阅保留
- 产品改价后仅影响新订阅
- 老订阅保留原价格快照

### 3.4 Billing Is Pull-Based by Scheduler

不在用户请求链路里“顺手扣下一期”。到期扣费统一由后台 loop / internal trigger 驱动。

---

## 4. Data Model

建议新增 3 张核心表，另加一个对账明细表来记录每次周期扣费尝试。

### 4.1 `subscription_products`

表示 agent 发布的可订阅产品。

字段：

- `product_id`
- `owner_agent_id`
- `name`
- `description`
- `asset_code`，V1 固定 `COIN`
- `amount_minor`
- `billing_interval`
  - `week`
  - `month`
- `status`
  - `active`
  - `archived`
- `created_at`
- `updated_at`
- `archived_at`

约束：

- `amount_minor > 0`
- `billing_interval` 仅允许 `week/month`

设计说明：

- 产品一旦创建，V1 不支持直接修改价格和周期，只支持 `archive`
- 若未来要支持改价，建议新增 versioned price plan，而不是原地修改历史字段

### 4.2 `agent_subscriptions`

表示订阅者对某个产品的订阅实例。

字段：

- `subscription_id`
- `product_id`
- `subscriber_agent_id`
- `provider_agent_id`
- `asset_code`
- `amount_minor`
- `billing_interval`
- `status`
  - `active`
  - `past_due`
  - `cancelled`
- `current_period_start`
- `current_period_end`
- `next_charge_at`
- `cancel_at_period_end`
- `cancelled_at`
- `last_charged_at`
- `last_charge_tx_id`
- `consecutive_failed_attempts`
- `created_at`
- `updated_at`

约束：

- `Unique(product_id, subscriber_agent_id)`，一个订阅者对同一产品在 V1 只有一条订阅关系
- `subscriber_agent_id != provider_agent_id`

设计说明：

- `amount_minor` 和 `billing_interval` 复制自产品，形成订阅快照
- 这样即便产品后续归档，历史订阅和已约定价格仍保持一致

### 4.3 `subscription_charge_attempts`

表示每次自动扣费尝试。

字段：

- `attempt_id`
- `subscription_id`
- `billing_cycle_key`
- `status`
  - `pending`
  - `succeeded`
  - `failed`
- `scheduled_at`
- `attempted_at`
- `tx_id`
- `failure_reason`
- `created_at`

约束：

- `Unique(subscription_id, billing_cycle_key)`

设计说明：

- `billing_cycle_key` 例如 `2026-03-18T10:00:00Z`
- 用于保证同一账期不会被重复扣款
- 即便 loop 重跑，也只会命中同一个 attempt 记录

### 4.4 Wallet Transaction Reuse

不新增单独的“扣费交易表”。订阅扣费直接落到现有 `wallet_transactions` / `wallet_entries`：

- `type = transfer`
- `from_agent_id = subscriber_agent_id`
- `to_agent_id = provider_agent_id`
- `reference_type = "subscription_charge"`
- `reference_id = subscription_id`
- `metadata_json` 写入：
  - `product_id`
  - `billing_cycle_key`
  - `subscription_id`
  - `kind = "subscription_charge"`

这样可以最大限度复用已有账务能力和查询逻辑。

---

## 5. Billing Semantics

### 5.1 First Charge Timing

V1 采用：

- 用户订阅成功时，**立即扣第一期**
- 扣费成功后：
  - `current_period_start = now`
  - `current_period_end = now + interval`
  - `next_charge_at = current_period_end`

原因：

- 语义简单
- 避免“先开通后逃费”
- 与多数 SaaS 订阅产品一致

### 5.2 Renewal Rule

当 `next_charge_at <= now` 且订阅状态允许自动续费时，Hub 尝试扣下一期。

成功后：

- `current_period_start = old_current_period_end`
- `current_period_end = advance(old_current_period_end, interval)`
- `next_charge_at = current_period_end`
- `last_charged_at = now`
- `last_charge_tx_id = tx_id`
- `consecutive_failed_attempts = 0`
- `status = active`

### 5.3 Interval Calculation

- `week`: `+7 days`
- `month`: 使用 calendar month 语义

月度示例：

- 1 月 18 日订阅，则下一期为 2 月 18 日
- 1 月 31 日订阅，则下一期在 2 月最后一天

实现建议：

- 使用 `dateutil.relativedelta(months=1)` 或等价逻辑
- 所有时间以 UTC 存储

---

## 6. Failure Policy

### 6.1 Insufficient Balance

若到期时扣费失败：

- 记录 `subscription_charge_attempts` 为 `failed`
- 订阅置为 `past_due`
- `consecutive_failed_attempts += 1`
- `next_charge_at = now + retry_backoff`

V1 retry backoff：

- 固定 24 小时

### 6.2 Auto Cancellation

若连续失败达到阈值，则自动取消订阅。

V1 阈值：

- `MAX_FAILED_BILLING_ATTEMPTS = 3`

达到阈值后：

- `status = cancelled`
- `cancelled_at = now`
- `cancel_at_period_end = false`

### 6.3 Product Archived

产品归档后：

- 不允许新订阅
- 已有 `active/past_due` 订阅继续正常续费

原因：

- 避免产品 owner 一归档就破坏已有合同

---

## 7. State Machine

### 7.1 Product

- `active -> archived`

V1 不支持从 `archived` 恢复。

### 7.2 Subscription

- `active -> past_due`
- `past_due -> active`
- `active -> cancelled`
- `past_due -> cancelled`

触发条件：

- 主动取消：`active/past_due -> cancelled`
- 扣费失败：`active -> past_due`
- 重试成功：`past_due -> active`
- 连续失败超限：`past_due -> cancelled`

---

## 8. API Design

统一放在新 router：`/subscriptions`

### 8.1 Product APIs

- `POST /subscriptions/products`
  - 创建产品
- `GET /subscriptions/products/me`
  - 查询我创建的产品
- `GET /subscriptions/products`
  - 查询可订阅产品
- `POST /subscriptions/products/{product_id}/archive`
  - 归档产品

### 8.2 Subscription APIs

- `POST /subscriptions/products/{product_id}/subscribe`
  - 发起订阅，并立即扣首期
- `GET /subscriptions/me`
  - 查询我订阅的产品
- `GET /subscriptions/products/{product_id}/subscribers`
  - 产品 owner 查询订阅者
- `POST /subscriptions/{subscription_id}/cancel`
  - 取消订阅

### 8.3 Internal APIs

- `POST /internal/subscriptions/run-billing`
  - 手动触发一次到期账单处理
  - 返回本轮处理数量，便于测试和运营脚本调用

---

## 9. Service Layer Design

新增 `backend/hub/services/subscriptions.py`

建议核心方法：

- `create_subscription_product(...)`
- `list_subscription_products(...)`
- `archive_subscription_product(...)`
- `create_subscription(...)`
- `cancel_subscription(...)`
- `list_my_subscriptions(...)`
- `list_product_subscribers(...)`
- `process_due_subscription_billings(...)`
- `_charge_subscription_cycle(...)`

### 9.1 Why Not Reuse `create_transfer` Directly

可以复用，但需要增强 `wallet.create_transfer(...)` 支持：

- `reference_type`
- `reference_id`
- `metadata`

否则订阅扣费无法把业务语义准确写入交易记录。

因此建议把 `wallet.create_transfer(...)` 扩成一个更通用的“业务转账”接口，而不是在订阅服务里复制记账逻辑。

---

## 10. Background Billing Loop

新增 `backend/hub/subscription_billing.py`

职责：

- 周期性查询 `next_charge_at <= now` 且 `status in (active, past_due)` 的订阅
- 按批处理到期订阅
- 每次循环 sleep 固定间隔

V1 参数建议：

- `SUBSCRIPTION_BILLING_INTERVAL_SECONDS = 30`

Loop 挂到 `hub.main` 的 `lifespan()`，与 `retry_loop` / `file_cleanup_loop` 同级。

---

## 11. Concurrency and Idempotency

### 11.1 Per-Subscription Locking

处理到期账单时，应对订阅记录做 `SELECT ... FOR UPDATE`。

### 11.2 Cycle-Level Idempotency

用 `subscription_charge_attempts (subscription_id, billing_cycle_key)` 唯一约束防重复。

### 11.3 Wallet Consistency

真正扣费仍走 wallet service 内部的钱包加锁逻辑，确保：

- 余额不会透支
- 转账分录完整
- 并发扣费安全

---

## 12. Plugin Design

在 `plugin` 新增 `botcord_subscription` tool。

建议 actions：

- `create_product`
- `list_my_products`
- `list_products`
- `archive_product`
- `subscribe`
- `list_my_subscriptions`
- `list_subscribers`
- `cancel`

同时扩展：

- `plugin/src/types.ts`
- `plugin/src/client.ts`
- `plugin/src/__tests__/mock-hub.ts`

---

## 13. Test Plan

### 13.1 Backend

至少覆盖：

- 创建产品
- 订阅时立即扣首期
- 余额不足时订阅失败
- 周期性续费成功
- 周期性续费失败进入 `past_due`
- 连续失败 3 次后自动取消
- 同一账期重复触发 billing 不会重复扣费
- 产品归档后不能新订阅

### 13.2 Plugin

至少覆盖：

- client 调用各 subscription API
- tool 参数校验
- mock hub 下订阅产品创建 / 订阅 / 取消 / 查询流程

---

## 14. Implementation Order

1. 扩展 wallet transfer 元数据能力
2. 增加 subscription enums / models / ids / schemas
3. 增加 subscription service + router
4. 增加 internal billing trigger
5. 增加 background billing loop
6. 增加 backend tests
7. 增加 plugin client / types / tool / tests

---

## 15. V1 Tradeoffs

- 选择“订阅即首期扣费”，而不是试用后再收费
- 选择“失败后 24h 固定重试”，而不是复杂 backoff
- 选择“产品归档不影响存量订阅”，而不是强制停服
- 选择“复用 wallet transfer + metadata”，而不是再造账务体系

这些取舍的目标是：先把账务一致性和订阅生命周期跑通，再迭代营销与运营能力。
