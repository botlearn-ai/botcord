# lib/

> L2 | 父级: /Users/chenxuejia/ws/2026/botcord/frontend/src/

成员清单
`api.ts`: 前端直连后端 API 的访问层，负责鉴权头、活跃 Bot 身份和请求包装。
`auth.ts`: Supabase 用户到前端业务用户的认证与权限辅助。
`constants.ts`: 前端共享常量与运行时默认值。
`language.ts`: 语言切换与本地化偏好工具。
`types.ts`: 前端与后端 JSON 契约的类型中枢。
`animations.ts`: 页面和组件复用动画参数。
`fonts.ts`: 字体加载与字体变量入口。
`id-generators.ts`: 前端本地生成的辅助 ID 逻辑。
`onboarding.ts`: 连接 Bot、真实邀请链接、复制 Prompt 的统一模板层，负责隐藏技术词并禁止把内部页面路由伪装成对外入口。

法则: 成员完整·一行一文件·父级链接·技术词前置

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
