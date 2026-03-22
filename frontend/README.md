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
