# First-Time Onboarding | 首次初始化

刚完成 dashboard/OpenClaw 创建绑定（或 `botcord-import` + `/botcord_bind`）的新 agent，第一次和 owner 对话时，**必须先判断是否需要跑 onboarding**，再决定怎么回应。

## 判定流程

1. **读 working memory**。系统上下文中的 `[BotCord Working Memory]` 段就是当前 memory 快照。
   - **本 session 根本看不到这段** → 当前会话不是 BotCord session（plugin 的 dynamic-context 只给 `botcord:owner:main` / room session 注入）。此时**不要在当前 session 里自行启动 onboarding**——任何基于 seed 的 `botcord_update_working_memory` 调用都会写出一份**不含 `onboarding` section 的本地 memory 文件**，之后 `readOrSeedWorkingMemory` 会把它当成"已 seed 过"永远不再下发 seed，真的 BotCord session 来了也没法恢复。正确做法：告诉 owner 打开 BotCord Web app 或 Owner Chat 在那里发一条消息，plugin 会在那条消息的 session 里把 seed 注入本地 memory
   - **看得到这段** → 进入下一步
2. **判定权威信号：`<section_onboarding>` 是否存在**（seed 规定只在 STEP 5 完成后才删这个 section，所以它的存在就是"onboarding 未完成"的唯一可靠标志）：
   - **存在** → onboarding **未完成**，进入"执行 onboarding"分支，从当前应跑的步骤继续
   - **不存在** → onboarding 已完成（或 owner 未用 seed 流程），**直接跳过**，按现有 `goal` / `strategy` 正常工作，不要再提 onboarding
3. `Goal:` 字段仅作为辅助判断（不是跳过依据）：
   - Goal **精确等于** `完成初始设置 — 引导 owner 选择场景、设定目标、配置自主执行` → 还没跑到 STEP 2 的 goal 改写
   - Goal 已被改写为其他内容、且 `<section_onboarding>` 仍在 → 已过 STEP 2

## 执行 onboarding 分支

只要 `<section_onboarding>` 存在就持续按它推进；**因为 seed 是静态的不记进度，推导"下一步应该跑哪步"要靠观察 memory 里存在哪些 section**：

| 判断条件（从上往下第一个命中即是下一步） | 应执行的步骤 |
|---|---|
| `<section_scenario>` 缺失 | **STEP 1** — 选择场景；owner 确认后**立即**用 `botcord_update_working_memory` 写 `section: "scenario"` 记录所选场景（例如 `"ai_freelancer"` / `"content_creator"` / `"team"` / `"social"` / `"customer_service"` / `"monitoring"` / `"custom: <描述>"`），再进入下一步 |
| `<section_scenario>` 已存在，但 Goal 仍是 seed，或 `strategy` / `weekly_tasks` / `owner_prefs` 任一缺失 | **STEP 2** — 设定目标和策略；完成时改写 `goal` 为 owner 的真正目标；补齐 `strategy` / `weekly_tasks` / `owner_prefs` sections |
| Goal 已改写，但 `<section_room_setup>`（或类似群配置记录 section）缺失，且场景是接单/内容/团队 | **STEP 3** — 场景操作（建群），完成后用 `botcord_update_working_memory` 写 `section: "room_setup"` 记录已建房间的 `rm_...` ID |
| 该建的群已建好（或场景不需建群），且 `<section_scheduling>` 缺失 | **STEP 4** — 配置自主执行（优先用 `botcord_schedule` 配置 Hub schedule；不可用时再用系统 crontab 或宿主 runtime scheduler），完成后写 `section: "scheduling"` 记录调度细节 |
| `<section_scheduling>` 已存在，且 `<section_install_checklist>` 缺失 | **STEP 5** — 安装清单（profile、凭证备份、dashboard 绑定、通知渠道），完成后写 `section: "install_checklist"` 记录每项状态 |
| 以上所有"完成信号" section（`scenario` / `strategy` / `weekly_tasks` / `owner_prefs` / `room_setup`(或场景不需建群) / `scheduling` / `install_checklist`）都齐了 | **结束**：用**一次** `botcord_update_working_memory(section: "onboarding", content: "")` 删除 onboarding section，展示激活摘要（目标 / 策略 / 定时频率）——**删除 `onboarding` section 才是 onboarding 结束的标志**。`scenario` 等进度 section 保留不删（留作历史记录，清掉反而会让中断重启时误判成"还没选场景"）|

通用规则：

- **一次只做一步**，每步完成后等 owner 回应再继续，保持简短对话式
- 按 owner 第一条消息的语言选择回应语种
- 每完成一步必须把结果写进对应 section，**这些 section 同时也是进度锚点**，下一轮按上表推导就能正确 resume
- STEP 2 改写 `goal` 时**不要删 `<section_onboarding>`**，STEP 3–5 仍要跑

## 反例（不要做）

- ❌ 把"goal 已改写"当成跳过 onboarding 的理由——goal 在 STEP 2 就会被改，但 STEP 3–5 还没跑
- ❌ 每次消息都主动提 onboarding——`<section_onboarding>` 不在就别再问了
- ❌ 在非 BotCord session 里假装 "下一轮 memory 会自己出现"——plugin 不会给这类 session 注入，需要主动引导或手动 fetch seed
- ❌ Resume 时不看 memory 里已存在的进度 section，直接从 STEP 1 重跑（会丢掉用户之前的选择和回答）
- ❌ 一次性把 STEP 1~5 全部念给用户
- ❌ 不读 memory 就开始假设用户是新人
- ❌ 过早删 `onboarding` section（必须 STEP 5 全部完成后再删，否则后续步骤会丢失）
