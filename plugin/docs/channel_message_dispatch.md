下是 session 分发机制的详细解读：
                                                                                                                                            
  Channel 收到消息时的 Session 分发逻辑                                                                                             
                                                                                                                                            
  整个流程分两步：路由解析（决定哪个 agent 处理）和 session key 生成（决定用哪个会话上下文）。                                              
                                                                                                                                            
  ---                                                                                                                                       
  第一步：路由解析 — resolveAgentRoute()                          

  入口在 src/routing/resolve-route.ts:614。Channel 收到消息后，preflight 阶段会调用此函数，传入：

  resolveAgentRoute({
    cfg,                    // 全局配置
    channel: "discord",     // 哪个 channel
    accountId: "bot-token1",// 哪个账号
    peer: { kind: "direct", id: "user-123" },  // 消息发送者
    parentPeer,             // 线程的父级 peer（用于继承绑定）
    guildId: "guild-456",   // Discord guild / Slack workspace
    teamId,                 // MS Teams team
    memberRoleIds: ["role-admin", "role-vip"], // 发送者的角色
  })

  路由按优先级从高到低的 7 个层级（tiers）逐级匹配 bindings 配置：

  优先级 1: binding.peer        — 精确匹配发送者 ID（如 user-123）
  优先级 2: binding.peer.parent — 线程消息：用父频道的 peer 匹配
  优先级 3: binding.guild+roles — guild + 角色组合匹配
  优先级 4: binding.guild       — 仅 guild 匹配
  优先级 5: binding.team        — team 匹配
  优先级 6: binding.account     — 仅 account 级别匹配
  优先级 7: binding.channel     — 通配（account="*"）
  兜底:     default             — 使用默认 agent

  匹配到第一个命中的 binding 就停止，从中取出 agentId。

  配置示例（bindings）：
  bindings:
    - agentId: "customer-support"
      match:
        channel: discord
        accountId: bot-token1
        peer: { kind: direct, id: "user-123" }  # 优先级1: 精确用户

    - agentId: "guild-bot"
      match:
        channel: discord
        guildId: "guild-456"
        roles: ["role-vip"]                      # 优先级3: VIP角色

    - agentId: "general"
      match:
        channel: discord
        accountId: "*"                           # 优先级7: 兜底

  ---
  第二步：Session Key 生成 — buildAgentPeerSessionKey()

  路由确定了 agentId 之后，生成 session key 来隔离会话上下文。关键逻辑在 src/routing/session-key.ts:127。

  Session key 的格式取决于 聊天类型 和 dmScope 配置：

  DM（直接消息）场景

  dmScope 控制 DM 会话的隔离粒度：

  ┌──────────────────────────┬───────────────────────────────────────────────────────┬─────────────────────────┐
  │         dmScope          │                   session key 格式                    │          效果           │
  ├──────────────────────────┼───────────────────────────────────────────────────────┼─────────────────────────┤
  │ main（默认）             │ agent:{agentId}:main                                  │ 所有 DM 共享一个会话    │
  ├──────────────────────────┼───────────────────────────────────────────────────────┼─────────────────────────┤
  │ per-peer                 │ agent:{agentId}:direct:{peerId}                       │ 每个发送者独立会话      │
  ├──────────────────────────┼───────────────────────────────────────────────────────┼─────────────────────────┤
  │ per-channel-peer         │ agent:{agentId}:{channel}:direct:{peerId}             │ 每个 channel+发送者独立 │
  ├──────────────────────────┼───────────────────────────────────────────────────────┼─────────────────────────┤
  │ per-account-channel-peer │ agent:{agentId}:{channel}:{accountId}:direct:{peerId} │ 最细粒度隔离            │
  └──────────────────────────┴───────────────────────────────────────────────────────┴─────────────────────────┘

  Group/Channel 消息场景

  群组消息始终按 channel + peer 隔离，不受 dmScope 影响：

  agent:{agentId}:{channel}:{peerKind}:{peerId}
  例: agent:main:discord:group:channel-789

  线程（Thread）场景

  在基础 session key 后追加 thread 后缀（src/routing/session-key.ts:234）：

  {baseSessionKey}:thread:{threadId}
  例: agent:main:discord:group:channel-789:thread:thread-001

  ---
  第三步：Identity Links — 跨 channel 会话合并

  配置 session.identityLinks 可以将不同 channel 的同一用户合并到同一个 session：

  session:
    dmScope: per-peer
    identityLinks:
      alice:                          # 统一身份名
        - "discord:user-123"         # Discord 上的 ID
        - "telegram:alice_tg"        # Telegram 上的 ID

  resolveLinkedPeerId() 会把 discord:user-123 和 telegram:alice_tg 都映射到 alice，生成相同的 session key：agent:main:direct:alice。

  ---
  完整流程图

  消息到达 channel
      │
      ├─ 提取: channel, accountId, peer(senderId), guildId, roles
      │
      ▼
  resolveAgentRoute()
      │
      ├─ 遍历 7 层 binding tiers（peer → parent → guild+roles → guild → team → account → channel）
      ├─ 首个命中 → 得到 agentId
      ├─ 无命中 → 使用 defaultAgentId
      │
      ▼
  buildAgentSessionKey()
      │
      ├─ DM? → 根据 dmScope 生成 key（main / per-peer / per-channel-peer / ...）
      ├─ Group? → agent:{agentId}:{channel}:{kind}:{peerId}
      ├─ identityLinks? → 替换 peerId 为统一身份
      │
      ▼
  resolveThreadSessionKeys()（如果是线程消息）
      │
      ├─ 追加 :thread:{threadId}
      │
      ▼
  最终 sessionKey → 用于加载/创建会话上下文 → 送入 AI pipeline

  核心设计思想：binding 决定"谁来处理"（agent 选择），session key 决定"在哪个上下文里处理"（会话隔离），两者独立但协同。