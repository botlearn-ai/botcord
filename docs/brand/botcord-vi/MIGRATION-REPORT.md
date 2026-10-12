# 全站共享组件迁移

日期：2026-10-12。实施完成；未合并或发布生产。迁移使用四个并行工作组，分别负责公开页与设置、团队、Dashboard 弹层、Dashboard 工作区；共享组件与集成验收由主工作组负责。

## 实际覆盖

- 登录、邀请、认领、激活、管理员、Daemon、权限设置、公开介绍与分享页。
- 团队列表、成员与 Agent 管理、会话、表单、弹窗和抽屉。
- Dashboard 导航、消息列表与输入、Bot / 联系人 / 探索、钱包、订阅、工具结果与业务弹层。
- 共享 UI 共 46 个模块，均可从 `/design` 示例入口到达。完整文件清单见 COMPONENT-INVENTORY.md。

业务层的原生 button / textarea / select / table / dialog / details 已替换。唯一保留的原生 input 是 MessageComposer 隐藏文件上传输入；它没有可见界面。`src/ui-migration.test.ts` 使用 TypeScript AST 检查，防止业务重新引入这些控件。

消息协议、编辑器行为、上传请求、权限与 API 保留在业务层；品牌图形、专业可视化、组合头像、PresenceDot 出席状态和文档拖拽拦截层也保留。迁移不等于把所有业务组件变成通用组件。

## 补充的接口与行为

- Button 增加 row / inline；LinkButton 保留链接语义、href 与新标签页行为。
- Input / Textarea 增加 composer / message；消息输入保留 IME、自动高度、mention 与原生 ref。
- DialogSurface 统一复杂业务弹层外壳，允许原调用方继续管理动画和生命周期。DismissLayer 统一仅负责点击关闭的导航遮罩。
- 弹层统一 Esc、Tab、滚动锁与焦点恢复；按可视 z-index 层级选择最上层弹窗。团队弹层通过 DashboardOverlayPortal 脱离祖先裁切和 transform。
- Card 支持列表语义与选中态；Checkbox 支持已有外层 label，避免嵌套标签。

## 验证

- `pnpm vitest run`：122 个文件、685 项测试全部通过；最终运行无未处理异常。
- `pnpm build`：通过。
- 共享 UI：21 个文件、73 项测试通过，覆盖新增原语、焦点、滚动锁、嵌套弹层和视觉层级。
- 浏览器桌面 1440px / 触控 375px：公开页、登录页、组件库、邀请码试点、访客 Dashboard 页面没有横向溢出。公开页浅色、Dashboard 深色均保留截图。
- 试点 1440 / 320 / 375 / 430px：创建、撤销取消、嵌套选择器边界、逐层 Esc 全部通过；确认没有真实 `/api/admin/` 请求。
- 设计防回退检查与 Agent 使用规则在配套 PR #1072 更新，具体结果见该 PR。

## 待验边界

设置页在访客状态正确跳转登录；团队页呈现登录失效状态。真实登录后的管理员、团队、支付、Daemon 和权限端到端链路尚未通过浏览器验证；对应表单和交互使用测试替身验证。

开发服务器切换 Settings 路由时记录了 Performance.measure 的 SettingsRoot 负时间戳异常，重复访问可复现，登录跳转仍正常。SettingsRoot 源码本次未改动，生产构建通过；尚未定位该开发时序异常，不将浏览器运行描述为零异常。

触控模拟不替代 iOS / Android 真机软键盘、安全区和横屏验收。上线前仍需使用相应账号与设备验证这些场景。

## 查看

本地组件库：`http://localhost:3000/design`；交互试点：`http://localhost:3000/design/pilot`。这两个入口仅开发和 Vercel 预览环境开放。

代表截图：`screenshots/migration-login-mobile.png`、`migration-workspace-mobile-dark.png`、`migration-pilot-mobile.png`、`migration-nested-mobile.png`。
