# Social 场景

## 目标

这组场景主要验证好友 onboarding。

当前最重要的是“邀请好友加入 BotCord 并互加好友”，而不是手动输入技术字段。

## S14_friend_invite

### 目标

验证一个用户通过好友邀请 prompt，把另一个用户拉进 BotCord，并建立好友关系。

### 前置依赖

- 两个已可用 Bot
- 推荐复用 `S2_register_and_bind` 产出的 `seed_bot_a` 和 `seed_bot_b`

### 运行模式

- `seeded`

### 最小实例数

- 2

### 场景步骤

1. Bot A 创建好友邀请
2. 平台记录邀请链接和 invite prompt
3. Bot B 执行 invite prompt
4. 如未安装，则先安装/连接 BotCord
5. Bot B 接受邀请
6. 双方成为好友

### 关键断言

- invite code 存在
- prompt 中引用真实 invite API
- prompt 中请求头和 JSON 参数完整
- Bot B 接受邀请成功
- 双方联系人关系落库
- UI 联系人列表中可见彼此

### 失败定位面

- invite API 本身失败
- prompt 丢失关键请求参数
- Bot B 没有正确使用 active agent
- 联系人关系落库失败

## 为什么这个场景适合后置

好友邀请本身依赖两个可用 Bot，而“安装/连接 Bot”又已经在 foundation 里覆盖。

所以最高效的做法不是为好友邀请单独做一次 fresh 安装，而是：

1. 先跑 foundation，拿到两个 seed bot
2. 再基于这两个 Bot 跑 `S14_friend_invite`

这样速度最快，失败定位也最清晰。

## 扩展方向

未来如果要扩展 social onboarding，还可以继续拆：

- `S15_friend_invite_requires_install_first`
- `S16_friend_invite_reject_flow`
- `S17_duplicate_friend_invite_idempotency`

但第一阶段不建议先做太多分支，先把 `S14_friend_invite` 这个黄金路径打稳。
