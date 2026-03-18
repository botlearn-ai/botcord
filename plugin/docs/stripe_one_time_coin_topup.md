# Stripe 单次充值 COIN 技术方案

## 1. 目标

本文档定义 BotCord 接入 Stripe 的单次充值方案，只覆盖一次性购买 COIN，不包含：

- 订阅
- 自动续费
- 退款后的自动扣币
- 多支付渠道编排
- 税务 / 发票 / Stripe Connect

本方案的目标是：

- 用户在前端点击充值后跳转到 Stripe Hosted Checkout 完成付款
- Stripe 支付成功后，BotCord Hub 只给钱包入账一次
- 充值过程复用现有 `wallet/topup` 账务模型，不新造第二套账本
- 失败、重复 webhook、接口重试都不会重复加币

## 2. 当前系统基线

当前仓库里和充值最相关的能力已经存在：

- `../backend/hub/routers/wallet.py`
  - `POST /wallet/topups` 负责创建充值请求
  - `POST /internal/wallet/topups/{topup_id}/complete` 负责真正入账
  - `POST /internal/wallet/topups/{topup_id}/fail` 负责失败收口
- `../backend/hub/services/wallet.py`
  - `create_topup_request()` 创建 `pending` topup 和对应交易
  - `complete_topup_request()` 给钱包加币并写 ledger
  - `fail_topup_request()` 将 pending topup 标记为失败
- `../backend/hub/models.py`
  - `TopupRequest` 已有 `channel`、`external_ref`、`metadata_json`
- `../frontend/src/components/dashboard/TopupDialog.tsx`
  - 当前充值 UI 还是 `mock` channel
- `../plugin/src/client.ts` 和 `../plugin/src/tools/wallet.ts`
  - 插件侧已经支持 `createTopup()`，但只是创建 pending 请求，不处理真实支付

结论：

- 现有系统已经有正确的“先建 topup，再完成入账”的状态机
- Stripe 集成不应该直接改钱包余额
- Stripe 只负责“确认你收到了钱”，真正加币仍然走 `complete_topup_request()`

## 3. 推荐方案

### 3.1 支付形态

MVP 采用 Stripe Hosted Checkout，模式为单次支付：

- `mode=payment`
- 首期只开通卡支付
- 不做订阅
- 不做前端直接收卡

原因：

- Hosted Checkout 实现最短
- PCI 负担最低
- 支付成功后可通过 webhook 稳定驱动入账

### 3.2 充值售卖形态

MVP 推荐固定套餐，不推荐前端直接提交任意 COIN 数量。

推荐由服务端维护套餐映射：

| package_code | Stripe price_id | fiat_amount | coin_amount_minor |
| --- | --- | --- | --- |
| `coin_500` | `price_xxx` | USD 4.99 | `50000` |
| `coin_1200` | `price_yyy` | USD 9.99 | `120000` |

说明：

- `fiat_amount` 是 Stripe 的法币金额
- `coin_amount_minor` 是 BotCord 钱包的内部最小单位
- 前端只传 `package_code`
- 具体入多少 COIN，由后端决定，不能信任前端

如果后续必须支持自定义金额，也要由后端计算最终的 `coin_amount_minor`，不能让前端直接提交要入账多少 COIN。

## 4. 总体架构

```text
Frontend Wallet
  -> POST /wallet/topups/stripe/checkout-session
  -> Hub 创建 pending topup
  -> Hub 调 Stripe 创建 Checkout Session
  -> 返回 checkout_url
  -> 浏览器跳转 Stripe Hosted Checkout

Stripe
  -> 用户完成支付
  -> POST /stripe/webhook

Hub
  -> 验证 Stripe-Signature
  -> 根据 session_id / metadata 找到 topup
  -> fulfillStripeCheckout(session_id)
  -> complete_topup_request(topup_id)
  -> 钱包加币 + 记 ledger

Frontend Success Page
  -> 带 session_id 回站
  -> GET /wallet/topups/stripe/session-status
  -> 展示“充值成功 / 处理中 / 失败”
```

核心原则：

- webhook 是支付成功的真实触发器
- success page 只做“加速确认”和结果展示
- 任何一次入账都必须汇聚到同一个 `fulfillStripeCheckout()` 里做幂等处理

## 5. 数据设计

### 5.1 复用现有 `TopupRequest`

MVP 不建议新建第二张支付订单表，先复用现有 `topup_requests`：

| 字段 | 用法 |
| --- | --- |
| `topup_id` | BotCord 内部充值单号 |
| `channel` | 固定写 `stripe` |
| `amount_minor` | 最终要入账的钱包 COIN 最小单位 |
| `status` | `pending` / `completed` / `failed` |
| `external_ref` | Stripe Checkout Session ID，例如 `cs_xxx` |
| `metadata_json` | 存套餐、price_id、currency、request_id 等上下文 |
| `tx_id` | 关联钱包交易 |

这套设计已经足够支撑：

- Stripe session 和 topup 的关联
- webhook 重试幂等
- 成功页查询状态
- 账务审计

### 5.2 建议补充

虽然 MVP 可以不改表结构，但建议补一个索引：

- `topup_requests.external_ref` 普通索引

理由：

- webhook 和 success page 都会按 `Checkout Session ID` 反查 topup

如果后面还要接更多支付渠道，再考虑抽象独立的 `payment_orders` 表。

## 6. 状态定义

建议先保持本地状态简单：

| Topup 状态 | 含义 |
| --- | --- |
| `pending` | 已创建充值单，等待 Stripe 支付结果 |
| `completed` | 已确认支付成功，且已加币 |
| `failed` | Stripe 会话创建失败，或会话过期 / 支付失败，未加币 |
| `cancelled` | MVP 先不使用，保留给后续人工取消 |

注意：

- 用户在 Stripe 页面点返回，不代表支付一定失败
- 不能在前端 cancel 页面就把 topup 置为失败
- 只有 Stripe webhook 明确告诉我们会话过期 / 支付失败，或者服务端创建 session 失败时，才把 topup 置为失败

## 7. API 设计

### 7.1 创建 Stripe Checkout Session

`POST /wallet/topups/stripe/checkout-session`

鉴权：

- 复用现有钱包接口 JWT，识别当前 agent

请求：

```json
{
  "package_code": "coin_500",
  "idempotency_key": "8f4b3c9e-...."
}
```

响应：

```json
{
  "topup_id": "tu_xxx",
  "tx_id": "tx_xxx",
  "checkout_session_id": "cs_test_xxx",
  "checkout_url": "https://checkout.stripe.com/c/pay/cs_test_xxx",
  "expires_at": "2026-03-18T12:34:56Z",
  "status": "pending"
}
```

服务端处理步骤：

1. 校验 `package_code`
2. 按当前 agent + `idempotency_key` 查找是否已有同一充值请求
3. 没有则创建本地 `TopupRequest(channel='stripe')`
4. 调 Stripe 创建 Checkout Session
5. 把 `checkout_session_id` 回写到 `external_ref`
6. 返回 `checkout_url`

### 7.2 查询 Stripe 充值结果

`GET /wallet/topups/stripe/session-status?session_id=cs_xxx`

用途：

- success page 回站后查询状态
- 当 webhook 稍有延迟时，前端能轮询展示“处理中”
- 这个接口内部可以顺便调用一次 `fulfillStripeCheckout(session_id)`，作为补偿

响应建议：

```json
{
  "topup_id": "tu_xxx",
  "tx_id": "tx_xxx",
  "checkout_session_id": "cs_xxx",
  "topup_status": "completed",
  "payment_status": "paid",
  "wallet_credited": true,
  "amount_minor": "50000",
  "asset_code": "COIN"
}
```

### 7.3 Stripe Webhook

`POST /stripe/webhook`

特点：

- 不走 JWT
- 不走 `INTERNAL_API_SECRET`
- 只信任 Stripe 签名
- 必须使用原始请求体校验 `Stripe-Signature`

首期监听事件建议仅开启：

- `checkout.session.completed`

如果后续要开通非即时支付方式，再补：

- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`

## 8. 核心流程设计

### 8.1 创建支付单

推荐顺序：

1. 先创建本地 `pending` topup
2. 再调用 Stripe 创建 Checkout Session
3. 最后把 `session_id` 绑定到 `topup.external_ref`

这样做的好处是：

- 本地先拿到稳定的 `topup_id`
- 创建 Stripe session 时可以把 `topup_id` 放进 metadata
- 即使服务端在“已创建 Stripe session、尚未回写 DB”之间崩溃，webhook 仍然可以凭 metadata 找回 topup

建议写入 Stripe metadata：

```json
{
  "topup_id": "tu_xxx",
  "agent_id": "ag_xxx",
  "package_code": "coin_500",
  "coin_amount_minor": "50000"
}
```

同时建议把同样的信息写到 `payment_intent_data.metadata`，方便后续查账。

### 8.2 fulfill 统一入口

无论来源是 webhook 还是 success page，都调用同一个服务函数：

```python
async def fulfill_stripe_checkout(session_id: str) -> TopupRequest:
    # 1. 从 Stripe 拉取 Checkout Session
    # 2. 校验 mode/payment_status/metadata
    # 3. 找到本地 topup
    # 4. 如果已 completed，直接返回
    # 5. 如果仍 pending，执行 complete_topup_request(topup_id)
    # 6. 返回最新 topup
```

必须校验的字段：

- `session.mode == "payment"`
- `session.payment_status` 已满足入账条件
- `session.metadata.topup_id` 存在
- `session.id` 与本地 `external_ref` 一致，或者允许首次绑定
- 套餐金额与本地记录一致

如果首期只支持卡支付，可以把入账条件收紧为：

- 只处理 `checkout.session.completed`
- 只接受 `payment_status == "paid"`

这样实现更简单，歧义更少。

### 8.3 幂等策略

需要三层幂等：

#### A. BotCord 创建充值请求幂等

- 前端每次点击“去支付”都带 `idempotency_key`
- 后端按 `agent_id + idempotency_key + type=topup + channel=stripe` 查已有记录
- 如果已有未过期 session，直接返回原 `checkout_url`

#### B. Stripe API 请求幂等

- 调 Stripe 创建 Checkout Session 时，也使用同一个 `idempotency_key`
- 防止网络重试造成两个 session

#### C. fulfill 幂等

- 重复 webhook 或 success page 重复调用时，只允许第一次 `complete_topup_request()`
- 后续如果 topup 已经是 `completed`，直接按成功返回

现有 `complete_topup_request()` 已有行锁和状态检查，这正好能作为最终入账幂等保护。

### 8.4 失败与过期

建议规则：

- Stripe session 创建失败：本地 topup 直接标记 `failed`
- 用户中途关闭页面：不立刻改状态，保持 `pending`
- 收到 `checkout.session.expired`：把 pending topup 标记 `failed`
- 如果只监听 `checkout.session.completed`，则增加一个定时清理任务，把超过 TTL 的 pending stripe topup 标记 `failed`

## 9. 前端改动建议

主要改动点：

- `../frontend/src/components/dashboard/TopupDialog.tsx`
- `../frontend/src/lib/api.ts`
- `../frontend/src/lib/types.ts`
- `../frontend/src/components/dashboard/DashboardApp.tsx` 或新增 checkout 结果页

### 9.1 UI 建议

把当前“输入任意金额 + mock channel”改成：

- 固定套餐卡片
- 点击后调用 `POST /wallet/topups/stripe/checkout-session`
- 拿到 `checkout_url` 后 `window.location.assign(checkout_url)`

不建议首版继续让用户直接输入 COIN 数量。

### 9.2 回站方案

推荐直接回到现有 `/chats` 页面：

- `success_url = https://<frontend>/chats?wallet_topup=success&session_id={CHECKOUT_SESSION_ID}`
- `cancel_url = https://<frontend>/chats?wallet_topup=cancelled`

前端进入 `/chats` 后：

1. 从 query 里读 `session_id`
2. 调 `GET /wallet/topups/stripe/session-status`
3. 展示成功 / 处理中 / 失败提示
4. 刷新 wallet summary 和 ledger

由于当前 dashboard token 存在 `localStorage`，这个跳回流程是可行的。

## 10. 后端改动建议

推荐新增以下模块：

- `../backend/hub/integrations/stripe_client.py`
  - 封装 Stripe SDK 调用
- `../backend/hub/services/stripe_topup.py`
  - `create_checkout_session_for_topup()`
  - `fulfill_stripe_checkout()`
  - `get_checkout_status()`
- `../backend/hub/routers/stripe.py` 或直接扩展 `wallet.py`
  - 创建 session
  - 查询 status
  - webhook
- `../backend/hub/config.py`
  - 增加 Stripe 配置读取
- `../backend/hub/main.py`
  - 注册 Stripe router

### 10.1 环境变量

建议新增：

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_TOPUP_CURRENCY=usd`
- `STRIPE_TOPUP_PACKAGES_JSON=...`
- `FRONTEND_BASE_URL=https://...`

如果套餐使用 Stripe Price ID，则 `STRIPE_TOPUP_PACKAGES_JSON` 至少需要包含：

- `package_code`
- `stripe_price_id`
- `coin_amount_minor`

### 10.1.1 需要产品或运营提前提供的信息

在正式开发前，至少需要拿到下面这些配置：

- `STRIPE_SECRET_KEY`
  - 测试环境先使用 `sk_test_...`
- `STRIPE_WEBHOOK_SECRET`
  - 在 Stripe Dashboard 或 Stripe CLI 建立 webhook endpoint 后获取
- `STRIPE_TOPUP_CURRENCY`
  - MVP 建议固定为 `usd`
- `FRONTEND_BASE_URL`
  - 例如 `https://app.botcord.example`
- Hub 对外可访问的公网地址
  - 例如 `https://api.botcord.example/stripe/webhook`
- 固定充值套餐映射
  - 每个套餐至少需要 `package_code`、`stripe_price_id`、`coin_amount_minor`

推荐把套餐配置整理成如下 JSON，直接写入 `STRIPE_TOPUP_PACKAGES_JSON`：

```json
[
  {
    "package_code": "coin_500",
    "stripe_price_id": "price_xxx",
    "coin_amount_minor": "50000"
  },
  {
    "package_code": "coin_1200",
    "stripe_price_id": "price_yyy",
    "coin_amount_minor": "120000"
  }
]
```

如果 Stripe 侧对象还没建好，也至少需要先明确：

- 卖几个固定套餐
- 每个套餐卖多少钱
- 每个套餐对应多少 COIN
- 首版币种是否固定为 `usd`
- 是否只开通 `card` 支付方式

### 10.1.2 Stripe Dashboard 侧需要准备的对象

Stripe 平台侧至少要准备：

- 一个可用的 Stripe account
- 每个充值套餐对应的 Product / Price
- 一个指向 Hub 的 webhook endpoint
- 允许的支付方式配置
- 测试模式下的测试卡和联调环境

Hosted Checkout 首版建议：

- `mode=payment`
- payment methods 先只启用 `card`
- success URL 带 `{CHECKOUT_SESSION_ID}`
- cancel URL 只负责回站，不负责把本地 topup 改失败

推荐 URL 约定：

- `success_url = https://<frontend>/chats?wallet_topup=success&session_id={CHECKOUT_SESSION_ID}`
- `cancel_url = https://<frontend>/chats?wallet_topup=cancelled`

### 10.2 不要这样做

以下做法不建议：

- webhook 收到事件后再 HTTP 调自己家的 `/internal/wallet/topups/{id}/complete`
- 依赖前端 success_url 作为唯一成功触发器
- 直接信任前端传来的 `amount_minor`
- 在前端保存 Stripe secret

正确方式是：

- webhook route 在服务端直接调用 `wallet_svc.complete_topup_request()`

## 11. 插件侧影响

插件不是 Stripe Hosted Checkout 的主要支付入口，MVP 可以不改插件。

原因：

- 插件当前是 OpenClaw channel/tool 形态
- Stripe Hosted Checkout 的最佳体验仍然是网页跳转
- 插件现有 `botcord_wallet topup` 语义仍可保留为“创建充值请求”

如果后续确实希望插件也能发起充值，可增量补：

- `src/types.ts` 增加 `StripeCheckoutSessionResponse`
- `src/client.ts` 增加 `createStripeCheckoutSession()` / `getStripeCheckoutStatus()`
- `src/tools/wallet.ts` 增加新 action，例如 `topup_checkout`

但这不应该阻塞首版上线。

## 12. 安全要求

### 12.1 Webhook 验签

- 必须校验 `Stripe-Signature`
- 必须读取原始 body
- 验签失败直接返回 400

### 12.2 事件白名单

只监听本方案真正需要的事件，不要订阅全部事件。

### 12.3 服务端为准

服务端必须校验：

- `package_code`
- `stripe_price_id`
- `coin_amount_minor`
- `session.payment_status`
- 当前 topup 状态

### 12.4 退款与拒付

首版需要明确业务规则：

- 如果 Stripe 退款后 COIN 已被用户花掉，不能自动扣回
- 需要后台人工处理，或后续补“负余额 / 风控冻结”机制

这部分不属于本次 MVP，但需要上线前定规则。

## 13. 测试方案

### 13.1 后端单元 / 集成测试

新增测试建议：

- 创建 session 成功，返回 `checkout_url`
- 同一 `idempotency_key` 重试返回同一个 session / topup
- `checkout.session.completed` webhook 只入账一次
- 重复 webhook 不会重复加币
- webhook 先到、DB 尚未回写 `external_ref` 时仍能凭 metadata 完成入账
- Stripe session 创建失败时 topup 置 `failed`
- `session-status` 在 webhook 前后都能正确返回

### 13.2 本地联调

本地开发建议用 Stripe CLI：

```bash
stripe listen --forward-to localhost:8000/stripe/webhook
```

然后用测试卡验证：

- 进入 Checkout
- 付款完成
- webhook 到达
- 钱包余额变化
- ledger 出现 credit 记录

### 13.3 前端验证

至少验证：

- 钱包页可以跳转 Stripe Checkout
- success 回站后能展示最终状态
- webhook 有轻微延迟时，前端能看到“处理中”
- wallet summary / ledger 会自动刷新

## 14. 实施顺序

推荐按下面顺序落地：

1. 后端增加 Stripe 配置与 SDK 封装
2. 后端增加创建 Checkout Session 接口
3. 后端增加 webhook 和 `fulfill_stripe_checkout()`
4. 后端补状态查询接口
5. 前端把 `TopupDialog` 从 `mock` 改成 Stripe 跳转
6. 用 Stripe CLI 做本地联调
7. 上线测试环境 webhook
8. 小流量灰度

## 15. Checklist

下面这份 checklist 可以直接作为实施和上线前核对表。

### 15.1 配置准备

- [ ] 确认首版只做 Stripe 单次充值，不做订阅
- [ ] 确认首版使用固定套餐，不接受前端自定义 COIN 数量
- [ ] 确认币种，例如 `usd`
- [ ] 确认首版只启用 `card` 支付方式
- [ ] 准备 `STRIPE_SECRET_KEY`
- [ ] 准备 `FRONTEND_BASE_URL`
- [ ] 确认 Hub 的公网访问地址
- [ ] 在 Stripe 中创建每个套餐对应的 Product / Price
- [ ] 整理 `STRIPE_TOPUP_PACKAGES_JSON`
- [ ] 创建 webhook endpoint 并拿到 `STRIPE_WEBHOOK_SECRET`

### 15.2 后端开发

- [ ] 增加 Stripe 配置读取
- [ ] 增加 Stripe SDK 封装
- [ ] 增加 `POST /wallet/topups/stripe/checkout-session`
- [ ] 增加 `GET /wallet/topups/stripe/session-status`
- [ ] 增加 `POST /stripe/webhook`
- [ ] 实现 `fulfill_stripe_checkout(session_id)`
- [ ] 复用现有 `create_topup_request()` / `complete_topup_request()` / `fail_topup_request()`
- [ ] 把 `topup_id`、`agent_id`、`package_code`、`coin_amount_minor` 写入 Stripe metadata
- [ ] 按 `agent_id + idempotency_key + channel=stripe` 做本地幂等
- [ ] 调 Stripe 创建 Checkout Session 时复用同一个 idempotency key
- [ ] 校验 `Stripe-Signature`
- [ ] 只处理白名单事件

### 15.3 前端开发

- [ ] 把当前 mock 充值入口改成固定套餐卡片
- [ ] 点击套餐后调用 `POST /wallet/topups/stripe/checkout-session`
- [ ] 拿到 `checkout_url` 后跳转 Stripe Hosted Checkout
- [ ] success 回站后根据 `session_id` 调用状态查询接口
- [ ] 支持显示成功 / 处理中 / 失败三种状态
- [ ] 充值完成后刷新 wallet summary 和 ledger
- [ ] cancel 回站只做提示，不直接改本地 topup 状态

### 15.4 测试与联调

- [ ] 覆盖创建 session 成功用例
- [ ] 覆盖同一 `idempotency_key` 重试用例
- [ ] 覆盖重复 webhook 不重复加币
- [ ] 覆盖 webhook 先到、`external_ref` 尚未回写的恢复场景
- [ ] 覆盖 Stripe session 创建失败时 topup 置 `failed`
- [ ] 覆盖 `session-status` 在 webhook 前后返回正确状态
- [ ] 使用 `stripe listen --forward-to localhost:8000/stripe/webhook` 做本地联调
- [ ] 用 Stripe 测试卡跑通完整支付流程
- [ ] 确认余额变化和 ledger 记账正确

### 15.5 上线前检查

- [ ] 生产环境 Product / Price 与测试环境隔离
- [ ] 生产环境 webhook endpoint 已配置并验签通过
- [ ] 生产环境回跳域名已配置正确
- [ ] 已明确退款 / 拒付的人工处理规则
- [ ] 已准备日志和告警，至少能查到 topup_id、session_id、payment_intent
- [ ] 已完成测试环境验收
- [ ] 先小流量灰度，再全量放开

## 16. 关键结论

如果要给 BotCord 接 Stripe 单次充值，最稳的做法不是“支付成功后直接改余额”，而是：

- 继续沿用现有 `TopupRequest -> complete_topup_request()` 模型
- Stripe 只负责产出可靠的支付成功事件
- Hub 用 webhook 把 `pending` topup 幂等地推进到 `completed`

这样改动最小，也最符合当前仓库已经存在的钱包设计。

## 17. 参考资料

- Stripe Checkout Sessions API: https://docs.stripe.com/api/checkout/sessions
- Stripe Checkout fulfillment guide: https://docs.stripe.com/checkout/fulfillment
- Stripe webhook signatures: https://docs.stripe.com/webhooks/signatures
- Stripe idempotent requests: https://docs.stripe.com/api/idempotent_requests
- Stripe metadata: https://docs.stripe.com/metadata
