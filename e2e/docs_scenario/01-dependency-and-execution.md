# 场景依赖与执行策略

## 依赖图

下面这张关系图用于指导 runner 排序和 seed 复用。

```text
S0_openclaw_boot
  -> S1_quickstart_install
    -> S2_register_and_bind
      -> S3_healthcheck_and_restart
      -> S4_claim_existing_bot
      -> S5_reset_credential
      -> S8_create_room
        -> S9_self_join_room
        -> S10_invite_other_to_room
          -> S11_share_link_lookup
          -> S12_visibility_and_policy
          -> S13_join_paid_room

S1_quickstart_install
  -> S6_link_existing_bot
  -> S7_create_new_bot

S2_register_and_bind + second bot
  -> S14_friend_invite
```

## 分层执行思路

### Layer 0: Seed Foundation

这层必须先过，不然后续大部分场景都不值得继续跑。

- `S0_openclaw_boot`
- `S1_quickstart_install`
- `S2_register_and_bind`
- `S3_healthcheck_and_restart`

产物：

- 至少 1 到 2 个已连接的 Bot
- 对应 `agentId`
- `openclaw.json` 快照
- credentials 快照
- healthcheck 输出

### Layer 1: Identity & Recovery

这层复用 Layer 0 的 Bot 身份，不需要重复安装插件。

- `S4_claim_existing_bot` — 需要一个**已注册但未绑定用户**的 Bot（即 S1/S2 产出的 agent，但 user_id 为 NULL 的状态）。注意：依赖图中 S4 挂在 S2 下方，指的是它需要 S2 的**注册产物**作为输入，但被 claim 的 Bot 本身必须处于 unbound 状态。
- `S5_reset_credential`
- `S6_link_existing_bot` — 需要一个已存在的 Bot 身份（plugin 已装好 + credentials 在本地），然后用 mode=link 重新连接。依赖图挂在 S1 下表示只需要 plugin 安装完成。
- `S7_create_new_bot` — 同上，需要一个已存在的 Bot 身份作为对照基线，然后用 mode=create 创建全新身份。依赖图挂在 S1 下。

### Layer 2: Room & Group

这层要求至少有 1 个已连接 Bot；邀请类场景要求 2 个 Bot。

- `S8_create_room`
- `S9_self_join_room`
- `S10_invite_other_to_room`
- `S11_share_link_lookup`
- `S12_visibility_and_policy`
- `S13_join_paid_room`

### Layer 3: Social

- `S14_friend_invite`

这层也要求至少两个可用 Bot。

## 运行模式

建议 runner 对每个场景都标注运行模式。

### `fresh`

定义：从空 `.openclaw/` 和空 `.botcord/` 启动。

适合：

- `S0_openclaw_boot`
- `S1_quickstart_install`
- `S2_register_and_bind`

特点：

- 真实覆盖冷启动体验
- 成本高
- 速度慢
- 失败时定位价值高

### `seeded`

定义：复用前一个 run 产出的 Bot 身份、配置和实例目录。

适合：

- `S3_healthcheck_and_restart`
- `S6_link_existing_bot` — 需要已有身份才能 link，standalone 模式��内置 S1 replay 作为 seed
- `S7_create_new_bot` — 需要已有身份作为对照基线，standalone 模式下内置 S1 replay 作为 seed
- `S4_claim_existing_bot`
- `S5_reset_credential`
- `S8_create_room`
- `S9_self_join_room`
- `S10_invite_other_to_room`
- `S11_share_link_lookup`
- `S12_visibility_and_policy`
- `S13_join_paid_room`
- `S14_friend_invite`

特点：

- 快很多
- 更适合业务路径组合测试
- 要求 artifact/seed 管理清晰

## 推荐执行档位

### Smoke

目标：最快验证主路径是否整体可用。

包含：

- `S0_openclaw_boot`
- `S1_quickstart_install`
- `S2_register_and_bind`
- `S3_healthcheck_and_restart`

用途：

- 主干合并后
- e2e runner 变更后
- 环境巡检

### Onboarding Core

目标：覆盖主要 onboarding 用户路径。

包含：

- `S0` 到 `S10`
- `S14_friend_invite`

用途：

- 每日定时跑
- release candidate 前跑

### Full Scenario

目标：覆盖 onboarding + 群权限/付费等重路径。

包含：

- `S0` 到 `S14`

用途：

- 发布前 gate
- 较大产品改动前回归

## 最高效的执行顺序

推荐按下面顺序组织一次完整 run：

1. 起 2 个实例
2. 跑 `S0_openclaw_boot`
3. 跑 `S1_quickstart_install`
4. 跑 `S2_register_and_bind`
5. 跑 `S3_healthcheck_and_restart`
6. 复用 Bot A 跑 `S8_create_room`
7. 基于 Bot A 的房间跑 `S9_self_join_room`
8. 用 Bot A 邀请 Bot B 跑 `S10_invite_other_to_room`
9. 顺带跑 `S11_share_link_lookup`
10. 同一对 Bot 跑 `S14_friend_invite`
11. 独立复用 Bot A 跑 `S5_reset_credential`

这样做的好处：

- 最贵的安装注册只做一次
- 两个 Bot 可以覆盖大多数社交和群场景
- 一个房间可复用出多个群相关场景

## 不建议的低效方式

下面这些安排会让 E2E 成本很高：

- 每个场景都从空实例 fresh 跑
- 建群场景和邀请场景各自重新安装注册一次
- 明明只需要 2 个 Bot，却默认拉 4 到 6 个容器
- 为了测分享 prompt，再单独新建一个群

## 场景产物复用建议

推荐把以下对象当成可复用 seed：

- `seed_bot_a`
- `seed_bot_b`
- `seed_room_public`
- `seed_room_private`
- `seed_friend_invite`
- `seed_room_invite`

后续 scenario 可以基于这些 seed 继续展开，而不是重做前置动作。
