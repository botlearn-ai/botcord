# Plugin 转账好友限制与转账记录私聊消息设计

## 1. 背景

当前 `plugin` 中的转账能力主要通过以下入口提供：

- `plugin/src/tools/payment.ts`
- `plugin/src/tools/wallet.ts`
- `plugin/src/client.ts` 中的 `createTransfer()`

现状是：

1. 只要收款方 `agent_id` 存在，就可以发起转账。
2. 转账成功后，只返回工具调用结果，不会额外发送转账记录私聊消息，也不会给双方推送事件通知。

新需求有三点：

1. 只有好友之间才能转账。
2. 转账成功后，只向收款方私聊发送一条特殊的转账记录消息。
3. 转账成功后，向付款方和收款方各推送一条轻量通知，分别提示“已转账 / 已收款”。


## 2. 目标

本次只先在 `plugin` 层完成能力收口，做到：

1. `botcord_payment.transfer` 和 `botcord_wallet.transfer` 发起转账前，先校验收款方是否是当前账号好友。
2. 校验失败时，直接拒绝转账，并返回明确错误信息。
3. 校验成功且转账成功后，自动向收款方私聊发送一条“转账记录消息”。
4. 校验成功且转账成功后，自动向付款方和收款方各推送一条轻量通知。
5. 文案和消息结构可被后续前端/客户端识别，具备扩展空间。


## 3. 非目标

以下内容不作为本次 plugin 文档范围内必须交付的项：

1. 不修改 Hub 后端的账务规则。
2. 不保证绕过 plugin 直接调用 Hub API 时也能被拦截。
3. 不在本期引入新的消息类型枚举。
4. 不处理“撤销转账”或“转账失败补偿消息”。
5. 不在本期强制新增 Hub 原生消息类型。

说明：

仅在 plugin 层加限制，属于“入口收口”。如果未来存在多个客户端、脚本或第三方接入，最终仍建议在 Hub 侧补一层强校验。


## 4. 当前代码结构分析

### 4.1 转账入口

`plugin/src/tools/payment.ts`

- `action === "transfer"` 时，直接调用 `client.createTransfer(...)`
- 当前没有好友关系校验

`plugin/src/tools/wallet.ts`

- `action === "transfer"` 时，也直接调用 `client.createTransfer(...)`
- 当前没有好友关系校验

### 4.2 好友关系能力

`plugin/src/client.ts`

- 已有 `listContacts(): Promise<ContactInfo[]>`
- 返回当前账号的联系人列表

`plugin/src/tools/contacts.ts`

- 已对联系人相关能力做了工具封装
- 但转账工具当前没有复用联系人能力进行前置校验

### 4.3 私聊消息能力

`plugin/src/client.ts`

- 已有 `sendMessage(to, text, options?)`
- 目标 `to` 支持 `ag_*`，可直接向对方发私聊消息

因此，从 plugin 现状看，本需求不需要新增底层传输协议，只需要在支付工具层增加业务流程控制。


## 5. 推荐实现方案

## 5.1 总体思路

在 `plugin` 内新增一个“转账守卫 + 转账记录消息 + 成功通知”流程：

1. 发起转账前，读取当前账号联系人列表。
2. 判断 `to_agent_id` 是否存在于联系人列表中。
3. 如果不是好友，直接返回错误，不调用 `createTransfer()`。
4. 如果是好友，调用 `createTransfer()`。
5. 转账成功后，调用 `sendMessage()` 给收款方发送一条特殊格式的私聊消息。
6. 同时给付款方和收款方各发送一条轻量通知。
7. 工具返回结果中，同时包含转账结果、记录消息发送结果和通知发送结果。


## 5.2 为什么优先放在工具层

推荐先把逻辑放在 `tool` 层，而不是直接塞进 `client.createTransfer()`：

1. `createTransfer()` 当前语义很单一，负责调用 Hub `/wallet/transfers`。
2. 好友校验和“成功后补发消息”属于业务编排，不是底层 HTTP client 的通用职责。
3. `botcord_payment` 与 `botcord_wallet` 可以共用同一段业务辅助函数，避免重复实现。

建议新增一个内部辅助模块，例如：

- `plugin/src/tools/payment-transfer.ts`

负责封装：

- 好友校验
- 执行转账
- 发送收款方私聊转账记录消息
- 发送双方通知消息
- 汇总返回结果


## 6. 详细设计

## 6.1 新增辅助函数

建议新增以下内部函数：

### `assertTransferPeerIsContact(client, toAgentId)`

职责：

1. 调用 `client.listContacts()`
2. 判断 `contact_agent_id === toAgentId`
3. 若不存在则抛错

建议错误文案：

```text
Transfer is only allowed between contacts. Please add this agent as a contact first.
```

说明：

- 这个校验应发生在 `createTransfer()` 之前。
- 这是本需求最核心的业务门禁。

### `buildTransferRecordMessage(tx, counterpartyDisplayName?)`

职责：

1. 根据交易结果生成用于私聊发送的消息文本
2. 保证后续有稳定格式可解析

建议消息文本示例：

```text
[BotCord Transfer]
Status: completed
Transaction: tx_xxx
Amount: 7000 minor units
Asset: COIN
From: ag_sender
To: ag_receiver
Memo: invoice settlement
Created: 2026-03-19T12:34:56.000Z
```

说明：

- 这里建议先用稳定文本前缀 `[BotCord Transfer]`
- 这样现有消息通路无需扩展协议，也便于后续在 UI 侧识别
- 该消息只发送给收款方，用作私聊里的收款记录

### `buildTransferNotificationMessage(tx, role)`

职责：

1. 生成付款方和收款方对应的轻量通知文案
2. 让通知语义和私聊记录消息分离

建议文案示例：

付款方：

```text
[BotCord Notice] Transfer sent: 7000 minor units to ag_receiver (tx: tx_xxx)
```

收款方：

```text
[BotCord Notice] Payment received: 7000 minor units from ag_sender (tx: tx_xxx)
```

说明：

- 这两条通知是事件提醒，不是聊天正文记录
- 目标体验类似好友请求通知
- 如果后续 Hub 支持更明确的通知型事件，可在不改业务语义的前提下替换底层实现

### `executeContactOnlyTransfer(client, params)`

职责：

1. 调用好友校验
2. 执行转账
3. 转账成功后向收款方发送私聊记录消息
4. 转账成功后向付款方和收款方分别发送通知
5. 返回统一结构

建议返回结构：

```ts
{
  tx: WalletTransaction,
  transfer_record_message: {
    attempted: true,
    sent: boolean,
    hub_msg_id?: string,
    error?: string,
  },
  notifications: {
    payer: {
      attempted: true,
      sent: boolean,
      hub_msg_id?: string,
      error?: string,
    },
    payee: {
      attempted: true,
      sent: boolean,
      hub_msg_id?: string,
      error?: string,
    }
  }
}
```


## 6.2 对 `botcord_payment` 的改造

文件：

- `plugin/src/tools/payment.ts`

改造点：

1. 在 `action === "transfer"` 分支中，不再直接调用 `client.createTransfer()`
2. 改为调用 `executeContactOnlyTransfer(...)`
3. `result` 中除了交易文本外，追加记录消息和通知发送状态

建议返回示例：

```json
{
  "result": "Transaction: tx_xxx\nType: transfer\n...\nTransfer record message: sent\nPayer notification: sent\nPayee notification: sent",
  "data": {
    "tx": { "...": "..." },
    "transfer_record_message": {
      "attempted": true,
      "sent": true,
      "hub_msg_id": "hm_xxx"
    },
    "notifications": {
      "payer": {
        "attempted": true,
        "sent": true,
        "hub_msg_id": "hm_xxx"
      },
      "payee": {
        "attempted": true,
        "sent": true,
        "hub_msg_id": "hm_xxx"
      }
    }
  }
}
```


## 6.3 对 `botcord_wallet` 的改造

文件：

- `plugin/src/tools/wallet.ts`

改造点：

1. 与 `payment.ts` 复用同一个辅助流程
2. 保持 legacy 工具与 unified payment 工具行为一致

原因：

- 否则两个入口对同一业务会出现不同规则，导致行为不一致


## 6.4 是否需要改 `client.ts`

推荐最小改动如下：

### 必需改动

无必需改动。

原因：

- `listContacts()`
- `createTransfer()`
- `sendMessage()`

这三个能力已经足够支撑需求。

### 可选优化

可以在 `client.ts` 新增：

### `isContact(agentId: string): Promise<boolean>`

内部逻辑：

1. 调用 `listContacts()`
2. 返回布尔值

但这只是语义优化，不是必要条件。


## 7. 转账记录消息与通知设计

## 7.1 为什么先用普通 `message`

当前 `plugin/src/types.ts` 的 `MessageType` 没有 `transfer_record` 之类的枚举，已有类型包括：

- `message`
- `ack`
- `result`
- `error`
- `contact_request`
- `contact_request_response`
- `contact_removed`
- `system`

本次推荐先复用普通 `message`，并通过固定前缀和结构化文本表达“这是特殊转账记录消息”。

优点：

1. 无需修改签名协议和消息类型枚举。
2. 无需联动 Hub、客户端、测试协议层。
3. 风险小，上线快。

缺点：

1. 语义仍然是“普通消息”。
2. 如果未来需要 UI 上做强样式渲染，可能需要额外解析文本或 payload。


## 7.2 私聊记录消息格式

推荐仍然走 `type: "message"`，但 payload 文本采用固定模板。

建议模板：

```text
[BotCord Transfer]
Status: completed
Transaction: <tx_id>
Amount: <amount_minor> minor units
Asset: <asset_code>
From: <from_agent_id>
To: <to_agent_id>
Memo: <memo_or_none>
Reference type: <reference_type_or_none>
Reference id: <reference_id_or_none>
Created: <created_at>
```

说明：

1. 该记录消息只发给收款方。
2. 它是聊天历史中的收款凭证，不承担通知分发职责。
3. 付款方不落同类私聊记录，避免聊天记录重复。

## 7.3 通知消息格式

除收款方私聊记录外，还需要补两条通知：

1. 给付款方一条“已转账”通知
2. 给收款方一条“已收款”通知

建议模板：

```text
[BotCord Notice] Transfer sent: <amount_minor> minor units to <to_agent_id> (tx: <tx_id>)
```

```text
[BotCord Notice] Payment received: <amount_minor> minor units from <from_agent_id> (tx: <tx_id>)
```

说明：

1. 这两条通知更像好友请求通知，是事件提醒。
2. 它们和私聊记录消息职责不同，不应混为一条。
3. 若现有通知链路支持“不触发 agent turn 的推送型消息”，建议复用该链路；否则第一期可先用固定前缀消息模拟通知语义。


## 8. 失败处理策略

## 8.1 好友校验失败

行为：

1. 不调用 `createTransfer()`
2. 直接返回错误

建议错误文案：

```text
Payment action failed: Transfer is only allowed between contacts. Please add this agent as a contact first.
```


## 8.2 转账成功，但记录消息或通知发送失败

行为建议：

1. 转账结果保持成功
2. 在返回值中标记 `transfer_record_message.sent = false`
3. 对通知失败也在 `notifications` 中标记
4. `result` 文本中补充警告

原因：

- 账务动作已经完成，不能因为通知消息失败就把整个转账判定成失败

建议文本：

```text
Transfer completed, but some follow-up messages failed to send.
```


## 8.3 转账失败

行为：

1. 不发送转账记录消息
2. 不发送通知
3. 按当前错误处理逻辑返回


## 9. 测试设计

## 9.1 需要新增的测试

### `plugin/src/__tests__/payment.integration.test.ts`

新增场景：

1. 非好友转账被拒绝
2. 好友转账成功，并向收款方发送记录消息
3. 好友转账成功，并向双方发送通知
4. 好友转账成功，但记录消息或通知发送失败时，交易仍成功

### `plugin/src/__tests__/client.integration.test.ts`

这个文件主要覆盖 client，本期不一定需要改。

因为好友限制和补发消息属于工具层编排，不属于 `BotCordClient` 基础能力。

### `plugin/src/__tests__/mock-hub.ts`

可能需要补充能力：

1. 让测试可预置联系人列表
2. 允许校验发送出去的消息内容
3. 支持模拟 `/hub/send` 失败，覆盖“转账成功但通知失败”分支


## 9.2 建议断言

### 非好友转账

断言：

1. 返回错误包含 `only allowed between contacts`
2. `walletTransactions` 长度仍为 `0`
3. `messages` 长度仍为 `0`

### 好友转账成功

断言：

1. 交易创建成功
2. `walletTransactions` 长度为 `1`
3. `messages` 长度增加 `3`
4. 其中 1 条是发给收款方的 `[BotCord Transfer]`
5. 其中 1 条是发给付款方的 `[BotCord Notice] Transfer sent`
6. 其中 1 条是发给收款方的 `[BotCord Notice] Payment received`
7. 三条消息都包含对应 `tx_id`

### 通知失败但交易成功

断言：

1. 工具返回中交易对象存在
2. 失败项在 `transfer_record_message` 或 `notifications` 中被正确标记
3. 账本扣款已发生


## 10. 涉及文件

建议改动文件：

- `plugin/src/tools/payment.ts`
- `plugin/src/tools/wallet.ts`
- `plugin/src/__tests__/payment.integration.test.ts`
- `plugin/src/__tests__/mock-hub.ts`

建议新增文件：

- `plugin/src/tools/payment-transfer.ts`


## 11. 兼容性与风险

## 11.1 兼容性

该方案对现有 Hub API 的最低要求如下：

1. 联系人列表接口可正常返回
2. 普通私聊发送接口可正常使用
3. 若要完全做成“好友请求那样”的通知体验，还需要现有通知分发链路能承载支付类通知

因此属于 plugin 侧兼容性较好的改造。


## 11.2 风险

### 风险 1：只在 plugin 层限制，不足以形成最终安全边界

说明：

- 如果其他客户端直接打 Hub `/wallet/transfers`，仍可能绕过好友限制

建议：

- 后续在 Hub `/wallet/transfers` 增加同样校验，plugin 侧保留为用户体验层的早失败

### 风险 2：联系人列表是运行时查询，转账链路多一次请求

影响：

- 转账延迟会略增

建议：

- 第一阶段接受该成本
- 若后续量大，再考虑短时缓存联系人集合

### 风险 3：通知语义和普通消息语义可能混用

影响：

- 客户端可能只能基于文本前缀或 payload 规则做识别

建议：

- 第一阶段先走固定文本前缀
- 第二阶段若需要丰富 UI，再扩展 message payload schema 或新增专用消息类型


## 12. 后续可选演进

如果未来希望把这个能力做得更完整，建议按顺序演进：

1. Hub 侧 `/wallet/transfers` 增加“仅联系人可转账”的硬校验
2. 将转账记录升级为结构化 payload，而不是纯文本
3. 为“已转账 / 已收款”引入专用 notification event
4. 视需要新增专用消息类型，例如 `system` + `subtype=transfer_record`
5. 支持国际化文案与金额展示格式


## 13. 推荐落地顺序

1. 在 `tool` 层加好友校验
2. 在 `tool` 层加收款方记录消息发送
3. 在 `tool` 层加付款方/收款方通知发送
4. 补充 integration tests
5. 验证 `botcord_payment` 与 `botcord_wallet` 行为一致


## 14. 结论

基于当前代码结构，本需求最合适的实现方式是：

1. 在 `plugin` 的支付工具层增加“仅好友可转账”校验
2. 在转账成功后，只向收款方发送一条带固定前缀的特殊私聊记录消息
3. 同时向付款方和收款方各发送一条轻量通知，分别提示“已转账 / 已收款”
4. 通过新增一个共享辅助模块，让 `botcord_payment` 与 `botcord_wallet` 使用同一套流程

这样改动面最小、风险最低、测试边界清晰，也为后续在 Hub 侧补强规则保留了空间。
