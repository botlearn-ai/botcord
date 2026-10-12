---
name: botcord-ui
description: 在 BotCord 仓库创建或修改前端页面、组件和样式时，应用 VI v1.0 视觉规范、共享组件和设计检查。
---

# BotCord UI（VI v1.0）

在 `frontend/` 写界面时按本文执行。规则来源：

- 视觉规范：`docs/brand/botcord-vi/VI.md`（唯一文字来源，数值以 `tokens/botcord.tokens.json` 为准）
- 全仓组件盘点：`docs/brand/botcord-vi/COMPONENT-INVENTORY.md`（`cd frontend && node scripts/audit-ui-components.mjs` 重新生成）
- 组件 API 契约：`docs/brand/botcord-vi/COMPONENTS.md`
- Tailwind 颜色桥：`frontend/src/styles/botcord-tailwind.css`；旧 token 映射：`frontend/src/app/globals.css` 顶部
- 防回退检查：`frontend/src/design-lint.test.ts` + `design-lint.baseline.json`

本文和上面文件冲突时，以 VI.md / COMPONENTS.md 为准。

## 1. 先找组件，再写 className

组件都在 `frontend/src/components/ui/<Name>.tsx`。先检查已有组件及 COMPONENTS.md 的 API；存在就复用，缺少时先补组件和行为测试，再在页面里使用。不要在业务文件里临时手写一份。

| 需要 | 用 |
|---|---|
| 纯图标按钮 | `IconButton`，必须提供 `label`，不要只提供 title |
| 按钮 | `Button`（`variant: primary \| secondary \| ghost \| danger`，`size: sm \| md`，`loading`）。一屏只有一个 `primary` |
| 输入框 / 多行输入 | `Input` / `Textarea`（`invalid`）；带标签、提示、错误时外面包 `Field` |
| 原生下拉 / 带说明单选 / 多选 | `Select` / `SingleSelect` / `MultiSelect`；原生表单提交用 Select，旧 DashboardSelect / DashboardMultiSelect 是兼容导出 |
| 搜索框 | `SearchInput`；防抖和 API 请求留在业务层 |
| 单选按钮 | `Radio`；组内共享 name，外层提供 label / fieldset |
| 行内提示 | `Alert`（neutral / success / warning / danger）；瞬时结果用 Toast |
| 抽屉 | `DrawerShell`；复杂业务抽屉迁移时保留嵌套确认与生命周期 |
| 数据表 / 指标卡 / 折叠区 | `Table` 系列 / `MetricCard` / `Disclosure` |
| 弹窗 | `DialogShell` + `useDialogClose`；dashboard 弹窗外层再包 `withDashboardOverlayPortal` |
| 确认 / 提示框 | `useConfirm()`（`ConfirmDialog`），不要用 `window.confirm` |
| 结果反馈（已保存、失败） | `toast({ title, tone })`（`<Toaster />` 挂在 `app/layout.tsx`） |
| 头像（agent / 人类 / room） | `Avatar kind="agent" \| "human" \| "room"`；旧的 `BotAvatar` / `ParticipantAvatar` 只做兼容，新代码不用 |
| agent 运行状态点 | `SignalDot status=...`，或给 `Avatar` 传 `status` |
| "头像 + 名称 + 一行状态" | `StatusCapsule` |
| 品牌图形的状态动画 | `NodeCordStatus` |
| 标签、计数、状态徽章 | `Badge`；未读数字用 `UnreadBadge` |
| 卡片 / 可点击卡片 | `Card`（`variant="interactive"`、`as="button"`） |
| 空列表、无结果 | `EmptyState`（lucide 图标 + 标题 + 一句说明 + 可选操作） |
| 加载占位 | `Skeleton`；整页加载用 `BotCordLoader` |
| 分段切换 / 标签页 | `Tabs`（`segmented` 或 `underline`） |
| 下拉菜单、更多操作 | `Menu` / `MenuItem`（危险项 `danger`） |
| 悬停说明 | `Tooltip` |
| 开关 / 勾选 | `Switch` / `Checkbox` |
| 可复制的 ID | `CopyableId`（ID 用 Geist Mono） |
| Logo、背景图形 | `BrandMark`、`CordField`（只用于营销页 hero、分享图、空状态插画，不进 dashboard 工作区） |

找不到合适组件：先在 COMPONENTS.md 补契约、在 `components/ui/` 实现，再使用。

## 2. Token 速查

### 颜色：只用语义类

| 角色 | 类名 |
|---|---|
| 页面 / 卡片 / 弹层 / 凹陷（输入框、代码块） | `bg-bg` / `bg-surface` / `bg-surface-raised` / `bg-surface-sunken` |
| 边框 | `border-border`、`border-border-strong` |
| 文字 | `text-text-primary`（或 `text-text`）、`text-text-secondary`、`text-text-tertiary`（只用于占位和禁用） |
| 主色 | `bg-accent text-on-accent`、`hover:bg-accent-hover`、`text-accent-text`（链接 / 强调文字）、`bg-accent-soft`（选中背景）、`text-brand` |
| 语义色 | `text-success` / `text-warning` / `text-danger`，背景 `bg-success-soft` / `bg-warning-soft` / `bg-danger-soft` |
| 焦点 | `focus-visible:ring-2 ring-focus-ring` |
| agent 色 | `bg-agent-{coral,amber,lime,green,cyan,blue,violet,pink}`（只给头像和 agent 标识用） |

- 透明度用修饰符：`bg-accent/10`、`border-danger/40`，不要写 `rgba(...)`。
- 旧类名 `neon-cyan`、`glass-bg`、`glass-border`、`deep-black`、`text-text-primary` 已映射到 VI，存量可以留；新代码优先语义类。`neon-purple` 不再是品牌色。
- 比例：中性色约 90%，主色 ≤ 8%，语义色 ≤ 2%。主色只用在主按钮、链接、选中态、焦点环和信号点。

### 圆角（VI 名称 → Tailwind 类名，注意错位一级）

| 用途 | VI | 类名 |
|---|---|---|
| 小标签 | xs 4 / sm 6 | `rounded` / `rounded-md` |
| 输入框、按钮 | md 8 | `rounded-lg` |
| 卡片、菜单 | lg 12 | `rounded-xl` |
| 原生下拉 / 带说明单选 / 多选 | `Select` / `SingleSelect` / `MultiSelect`；原生表单提交用 Select，旧 DashboardSelect / DashboardMultiSelect 是兼容导出 |
| 搜索框 | `SearchInput`；防抖和 API 请求留在业务层 |
| 单选按钮 | `Radio`；组内共享 name，外层提供 label / fieldset |
| 行内提示 | `Alert`（neutral / success / warning / danger）；瞬时结果用 Toast |
| 抽屉 | `DrawerShell`；复杂业务抽屉迁移时保留嵌套确认与生命周期 |
| 数据表 / 指标卡 / 折叠区 | `Table` 系列 / `MetricCard` / `Disclosure` |
| 弹窗 | xl 16 | `rounded-2xl` |
| 营销大卡片 | 2xl 24 | `rounded-3xl` |
| 胶囊、头像 | full | `rounded-full` |

不写规范外的任意圆角。`Avatar` 内部的 `rounded-[30%]` / `rounded-[24%]` 是 VI 定义的身份形状。

### 字号（最小 12px）

| token | 类名 |
|---|---|
| caption 12/500（标签、时间戳、徽章） | `text-xs font-medium` |
| body-sm 13（次要信息、列表） | `text-[13px]` |
| body 14（界面默认正文、消息） | `text-sm` |
| body-lg 16（营销正文） | `text-base` |
| h4 18 / h3 22 / h2 28 / h1 36 / display 56 | `text-lg` / `text-[22px]` / `text-[28px]` / `text-4xl` / `text-[56px]`，字重 600，标题加负字距 |
| mono 13（ID、代码、哈希） | `font-mono text-[13px]` |

- 字重只用 400 / 500 / 600（`font-normal` / `font-medium` / `font-semibold`）。
- `text-[11px]` 只允许两处：未读数字徽章、dashboard 左侧 64px 导航栏的图标标签。`text-[8–10px]` 一律不允许。
- 字体：Geist / Geist Mono（`lib/fonts.ts`），中文跟随系统。不要引入 Inter、JetBrains Mono 或其他网络字体。

### 间距、阴影、动效

- 间距 4px 基准（Tailwind 默认刻度 `1 2 3 4 5 6 8 10 12 16 20 24`）。
- 阴影：`shadow-sm`、`shadow-md` 级别即可；不加彩色发光阴影。
- 时长：`duration-[var(--bc-duration-fast)]`（140ms，hover / 颜色）、`--bc-duration-base`（220ms，弹层 / 面板）、`--bc-duration-slow`（360ms，页面级）；缓动 `ease-[var(--bc-ease-standard)]`。这些变量在 reduced motion 下自动为 0。
- 动效只表达状态和层级变化；一个界面同时只有一处循环动画（通常是当前活动 agent 的信号点）。
- 位移和循环动画加 `motion-reduce:` 关闭（如 `motion-reduce:animate-none`）。

## 3. Agent 视觉层

- **形状区分身份**：agent 圆形；人类 owner 圆角方形 30%；room 圆角方形 24%。用 `Avatar kind` 自动处理，不要自己写 `rounded-*`。
- **agent 内置头像**：16 角色 × 8 色 SVG（`/agent-avatars/<角色>-<颜色>.svg`）。无图时 `Avatar` 按 agent ID 哈希取默认头像（`lib/bot-avatars`）。不画屏幕脸 / 显示器脸机器人，不用像素 PNG，不用 emoji 当头像。
- **信号点状态**（`SignalDot` / `Avatar status`）：

| status | 含义 | 表现 |
|---|---|---|
| `idle` | 空闲 | 中性灰，无动画 |
| `online` | 在线 | 品牌色 |
| `thinking` | 正在思考 | 品牌色，呼吸 |
| `replying` | 正在回复 / 发送 | 品牌色 |
| `waiting` | 等待授权 | warning，外圈闪烁 |
| `done` | 已完成 / 已送达 | success |
| `offline` | 离线 | 空心灰环 |

- **StatusCapsule**：头像 + 名称（13px/600）+ 一行状态（12px `text-text-secondary`），高 40（紧凑 32）。等待授权时右侧放"拒绝 / 允许"两个 `Button`，"允许"用 `primary`。
- **NodeCordStatus**：`sending` / `thinking` / `delivered` / `waiting` / `offline` 表达网络状态。
- **严肃场景只用静态**：钱包、转账、签名、密钥、安全告警里，`NodeCordStatus state="static"`，不放循环动画，不用拟人化表达和玩笑语气。

## 4. 图标

- 只用 `lucide-react`，`strokeWidth={1.75}`，尺寸 16 / 20 / 24（`size-4` / `size-5` / `size-6`）。
- 颜色跟随文字（`currentColor`）：默认 `text-text-secondary`，激活 `text-text-primary` 或 `text-accent-text`。
- 不混用填充风格图标；信号点、对勾等状态指示除外。
- 不新增手写内联 `<svg>` 图标。lucide 没有时，按 24 网格、1.75 线宽补画，集中放到一个图标组件里。
- 纯装饰图标加 `aria-hidden`；只有图标的按钮必须有 `aria-label`。

## 5. 文案

- 说具体的事：写"消息已签名并送达 3 个 agent"，不写"无缝连接、强大赋能"。
- 术语固定：Agent、Room（房间）、Topic（话题）、Message、Owner；写作 **BotCord**（不写 Botcord / BOTCORD）。
- agent 用第一人称汇报自己（"我正在整理会议纪要"），系统用第三人称（"Atlas 正在回复"）。
- 钱包、安全场景用平实准确的陈述，不加表情，不开玩笑。
- 英文标题用句首大写（Sentence case），不全大写。
- 界面文案按所在模块的现有方式提供中英文（`lib/i18n`），不要只写一种语言。

## 6. 禁止

- className 里写 hex（`bg-[#fff]`、`text-[#13161A]`）或 `rgba(...)` / `rgb(...)` 任意值。需要新颜色时先加 token。
- `text-[8px]`、`text-[9px]`、`text-[10px]`；`text-[11px]` 只限上面两处例外。
- 霓虹发光、玻璃拟态（`backdrop-blur` 毛玻璃卡片）、渐变文字（`bg-clip-text text-transparent`）、彩色光斑背景、装饰性循环动画。
- 新写 `fixed inset-0` 遮罩做弹窗 / 抽屉；用 `DialogShell`（+ `withDashboardOverlayPortal`）。
- 业务文件里手写按钮或输入框样式（`<button className="rounded-... bg-...">`）；用 `Button` / `Input` / `Card` 等组件。
- 紫色强调：`neon-purple`、`purple-*`、`violet-*`、`indigo-*` 作为强调色。`agent-violet` 只用于 agent 头像色。
- 屏幕脸 / 显示器脸机器人头像、像素头像。
- 用 `--bc-radius-*` 覆盖 Tailwind 的 `--radius-*`；在 `components/ui/` 外改 `botcord-tokens.css` / `botcord-tailwind.css`（这两个文件从 `docs/brand/botcord-vi/tokens/` 复制，改源头再复制）。
- 单一主题：浅色或深色下看不清的界面不算完成。

## 7. 迁移规则（Polar 规则）

前端里还有大量旧写法（neon / glass / zinc / 手写弹窗）。改到某个旧文件时：

1. 迁移你改到的部分：手写按钮 → `Button`，手写输入 → `Input`，手写弹窗 → `DialogShell`，手写徽章 → `Badge`，旧头像 → `Avatar`，sub-12px → `text-xs`，hex / rgba → 语义类。
2. 不顺手重写和本次任务无关的整个文件；范围大时单独提 PR。
3. 迁移后 `design-lint` 计数会下降，测试会提示调低 baseline：把 `frontend/src/design-lint.baseline.json` 里对应条目改成新数字（为 0 时删除该条）。baseline 只减不增；不要为了让测试通过调高它。

## 8. 提交前检查

在 `frontend/` 下：

新增组件或迁移入口后更新 `COMPONENTS.md` 和 `/design` 示例，并重新运行组件盘点脚本。运行状态 SignalDot 与出席状态 PresenceDot 不直接互换；业务消息、编辑器、文件上传请求和流式协议留在业务层。

1. `pnpm vitest run` 全部通过（包含 `src/design-lint.test.ts`）。失败信息会列出 `file:line`。
2. `pnpm build` 通过。
3. 浅色和深色主题都看一遍（`html[data-theme="light" | "dark"]`）：文字对比度、边框、hover / focus 状态。
4. 移动端宽度看一遍（dashboard 有 `max-md:` 布局）。
5. 新组件：有 `*.test.tsx`，文件头保留 `[INPUT]/[OUTPUT]/[POS]/[PROTOCOL]` 注释，交互组件有 role / aria 和键盘操作。
6. 一屏只有一个主按钮；循环动画最多一处；钱包 / 签名 / 安全界面无动画。
