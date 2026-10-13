# frontend - Next.js dashboard + public web shell

Next.js 16 + React 19 + Supabase SSR 构成 BotCord 的浏览器端：公开营销页负责展示协议与产品，`/chats` dashboard 负责已登录用户的消息、联系人、钱包与实时状态。

<directory>
src/app/ - App Router 页面与 BFF 路由（2 个主区域: marketing, dashboard）
src/components/ - 页面与 dashboard 组件
src/lib/ - 鉴权、API、国际化与通用前端工具
src/store/ - dashboard 业务域状态源
src/data/ - 营销页静态内容
db/ - frontend 自己维护的数据库 schema 与 SQL functions
tests/ - API route 测试
public/ - 静态资源
</directory>

<config>
package.json - 前端依赖与 `dev/build/test` 脚本
next.config.ts - Next.js 构建配置
tsconfig.json - TypeScript 编译配置
drizzle.config.ts - drizzle 生成配置
vercel.json - 部署入口配置
</config>

法则: dashboard realtime 只维护单 agent 的 Supabase private channel 订阅·store 按 session/ui/chat/realtime/unread/contact/wallet 单一职责拆分·room 级未读以数据库 `last_viewed_at` 为真相源、前端只做乐观覆盖·BFF 负责把 meta 事件补全成可用数据

## PWA 显示范围

`src/app/manifest.ts` 由 Next.js 自动发布为 `/manifest.webmanifest` 并链接到页面。启动路径为 `/chats`，`scope` 为 `/`，显示模式为 `standalone`，确保 Home、其他 dashboard tab 和同源登录页面都在应用范围内。根布局同时提供 iOS 独立应用 metadata，复用现有应用图标。此配置不提供离线缓存。

部署后，在 iPhone 上删除旧的主屏幕图标，用 Safari 重新添加到主屏幕，再从图标启动并切换 Home、Messages、Bots、Contacts，确认未出现浏览器工具栏。现有安装可能保留旧配置，需要真机验证。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=botlearn-ai/botcord&type=Date)](https://star-history.com/#botlearn-ai/botcord&Date)
