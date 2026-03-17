OpenClaw Hooks 配置详解                                         
                                                                                                                                                                                                                                               
  Hooks 是 OpenClaw 的 webhook 入站系统，让外部服务（如 Gmail、自定义 webhook）通过 HTTP 请求触发 agent 动作并可选地将回复投递到消息通道。
                                                                                                                                                                                                                                               
  ---                                                                                                                                                                                                                                          
  顶层配置字段                                                                                                                                                                                                                                 
                                                                                                                                                                                                                                               
  ┌──────────────┬────────────────────────────────────────────────────────────────────────────┐                                                                                                                                                
  │     字段     │                                    说明                                    │                                                                                                                                                
  ├──────────────┼────────────────────────────────────────────────────────────────────────────┤                                                                                                                                                
  │ enabled      │ 是否启用 hooks 系统                                                        │
  ├──────────────┼────────────────────────────────────────────────────────────────────────────┤
  │ token        │ 必填，Bearer 认证令牌（Authorization: Bearer <token> 或 X-OpenClaw-Token） │
  ├──────────────┼────────────────────────────────────────────────────────────────────────────┤
  │ path         │ HTTP 端点路径，默认 /hooks                                                 │
  ├──────────────┼────────────────────────────────────────────────────────────────────────────┤
  │ maxBodyBytes │ 请求体大小上限，默认 256KB                                                 │
  └──────────────┴────────────────────────────────────────────────────────────────────────────┘

  ---
  会话路由与安全控制

  defaultSessionKey — 未指定 session key 时的回退值，如 "hook:ingress"，所有 hook 请求共享同一会话。

  allowRequestSessionKey — 是否允许调用方在请求体中自行指定 sessionKey。false（默认）= 拒绝，返回 400。

  allowedSessionKeyPrefixes — session key 前缀白名单。**当 defaultSessionKey 未设置时，必须包含 "hook:"（OpenClaw 内置要求，缺少会导致 gateway 启动失败）。** 设为 ["hook:", "botcord:"] 时，session key 必须以 hook: 或 botcord: 开头，否则 400。BotCord Hub 推送使用 "botcord:" 前缀。

  allowedAgentIds — 允许路由到的 agent 白名单：
  - 省略或 ["*"] → 任意 agent
  - [] → 禁止显式路由，只用默认 agent
  - ["hooks", "main"] → 只允许这两个 agent，其他 ID fallback 到默认

  这四个字段组合起来控制了 谁能被唤醒、用哪个会话上下文。

  ---
  mappings — 路由规则

  每条 mapping 定义一个 webhook→agent 动作映射：

  {
    "match": { "path": "gmail" },   // 匹配 POST /hooks/gmail
    "action": "agent",               // 触发 agent 执行
    "agentId": "hooks",              // 目标 agent
    "wakeMode": "now",               // 立即唤醒
    "name": "Gmail",                 // 显示名
    "sessionKey": "hook:gmail:{{messages[0].id}}",  // 每封邮件独立会话
    "messageTemplate": "From: {{messages[0].from}}\nSubject: ...",
    "deliver": true,                  // 将回复投递到通道
    "channel": "last",                // 投递目标通道
    "model": "openai/gpt-5.2-mini"   // 可选，指定模型
  }

  关键字段：

  ┌─────────────────┬─────────────────────────────────────────────────────────────────────┐
  │      字段       │                                说明                                 │
  ├─────────────────┼─────────────────────────────────────────────────────────────────────┤
  │ match.path      │ 精确匹配请求路径（/hooks/gmail → "gmail"）                          │
  ├─────────────────┼─────────────────────────────────────────────────────────────────────┤
  │ match.source    │ 匹配请求体中 source 字段（同一 URL 按 payload 分流）                │
  ├─────────────────┼─────────────────────────────────────────────────────────────────────┤
  │ action          │ 目前为 "agent" — 触发一次隔离的 agent turn                          │
  ├─────────────────┼─────────────────────────────────────────────────────────────────────┤
  │ agentId         │ 目标 agent ID，需在 allowedAgentIds 白名单中                        │
  ├─────────────────┼─────────────────────────────────────────────────────────────────────┤
  │ wakeMode        │ "now" = 立即唤醒；"next-heartbeat" = 等下次心跳再处理               │
  ├─────────────────┼─────────────────────────────────────────────────────────────────────┤
  │ messageTemplate │ 模板字符串，{{payload.field}} 插值，作为 agent 输入消息             │
  ├─────────────────┼─────────────────────────────────────────────────────────────────────┤
  │ sessionKey      │ 支持模板插值，决定 agent 在哪个会话上下文中运行                     │
  ├─────────────────┼─────────────────────────────────────────────────────────────────────┤
  │ deliver         │ true（默认）= agent 回复投递到消息通道；false = 静默处理不投递      │
  ├─────────────────┼─────────────────────────────────────────────────────────────────────┤
  │ channel         │ 投递目标："last"（上次活跃通道）、"telegram"、"whatsapp" 等具体通道 │
  ├─────────────────┼─────────────────────────────────────────────────────────────────────┤
  │ to              │ 通道内的接收者（手机号/用户ID/频道ID），支持模板插值                │
  ├─────────────────┼─────────────────────────────────────────────────────────────────────┤
  │ name            │ mapping 显示名，用于日志和主会话摘要                                │
  └─────────────────┴─────────────────────────────────────────────────────────────────────┘

  ---
  模板插值语法

  {{ expr }} 双花括号，支持：
  - {{path}} — 请求路径
  - {{now}} — 当前 ISO 时间戳
  - {{headers.x-custom}} — 请求头
  - {{query.param}} — 查询参数
  - {{payload.messages[0].from}} — payload 嵌套字段/数组索引
  - 缺失值 → 空字符串；对象/数组 → JSON 序列化

  ---
  presets — 预设模板

  presets: ["gmail"] 会自动注入一套 Gmail 的 mapping 规则（match path gmail、消息模板等），省去手写。预设 mapping 追加在显式 mappings 之后。

  ---
  transformsDir — 自定义 JS/TS 变换

  指定一个目录（默认 ~/.openclaw/hooks/transforms），mapping 可引用其中的模块对 payload 做预处理：

  {
    "transform": { "module": "my-transform.ts" }
  }

  Transform 函数接收 { payload, headers, url, path }，返回 null 跳过该请求（204），或返回部分字段合并到 action 中。

  ---
  执行流程总结

  外部 POST /hooks/gmail
    → token 认证
    → mappings 按顺序匹配（match.path / match.source）
    → 首个命中的 mapping 生效
    → messageTemplate 插值生成消息
    → 解析 sessionKey / agentId
    → 启动隔离 agent turn（独立会话，cron job）
    → agent 产出回复
    → deliver=true? → 投递到 channel 指定的通道
    → 摘要始终写入主会话