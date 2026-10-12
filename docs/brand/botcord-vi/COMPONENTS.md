# BotCord UI 组件库（VI v1.0）

> 本文是 `frontend/src/components/ui/` 组件库的 API 契约。视觉规则以 `VI.md` 为准；组件实现、`/design` 预览页和 `botcord-ui` Skill 都以本文为准。
> 新界面一律用这里的组件拼；没有合适组件时先补组件，再用。

## 通用约定

- 位置：`frontend/src/components/ui/<Name>.tsx`，一个文件一个主组件（可附带少量子组件），默认导出主组件，具名导出子组件和类型。
- 文件头保留项目惯例的 `[INPUT]/[OUTPUT]/[POS]/[PROTOCOL]` 注释。
- 只用 VI 颜色语义类（`bg-surface`、`border-border`、`text-text-secondary`、`bg-accent`、`text-danger`、`bg-warning-soft`…，见 `styles/botcord-tailwind.css`）和旧 token（`neon-cyan` 等已映射到 VI）；**不写 hex、不写 rgba、不写规范外的任意字号**（VI 定义的 13px 等字号允许）（最小 `text-xs`，徽章数字例外 `text-[11px]`）。
- 圆角按 VI→Tailwind 对照：输入/按钮 `rounded-lg`(8)、卡片 `rounded-xl`(12)、弹窗 `rounded-2xl`(16)、大卡片 `rounded-3xl`(24)、胶囊/头像 `rounded-full`。
- `className` 透传到根元素；组件用 `clsx` 拼类名（项目没有 tailwind-merge，避免让调用方覆盖同一属性）。
- 支持浅色 / 深色（`html[data-theme]`），动画遵守 `prefers-reduced-motion`。
- 可访问性：交互组件有正确的 role / aria 属性和键盘操作；纯装饰元素 `aria-hidden`。
- 每个组件附一个 `*.test.tsx`（jsdom，参考 `ConfirmDialog.test.tsx`）覆盖主要行为。

## 已有（不改 API）

| 组件 | 说明 |
|---|---|
| `Button` | `variant: primary \| secondary \| ghost \| danger`，`size: sm \| md`，`loading` |
| `Input` / `Textarea` | `invalid` |
| `DialogShell` / `useDialogClose` | 弹窗外壳；dashboard 弹窗外层仍用 `withDashboardOverlayPortal` |
| `ConfirmDialog` + `useConfirm()` | 全局确认 / 提示 |
| `BrandMark`、`BotCordLoader`、`CordField` | 品牌元素 |
| `UnreadBadge`、`CopyableId` | 保持 |

## 新增 · 身份与状态（批次 1）

### `SignalDot`
```ts
type AgentSignal = "idle" | "online" | "thinking" | "replying" | "waiting" | "done" | "offline";
<SignalDot status={AgentSignal} size?: "xs" | "sm" | "md" /* 8/10/12px */ className? />
```
颜色：idle 中性灰；online / thinking / replying 品牌色；waiting warning；done success；offline 空心灰环。thinking 呼吸、waiting 外圈闪烁（VI §6.3）。带 `aria-label`（状态英文名）。

### `Avatar`
```ts
<Avatar
  kind: "agent" | "human" | "room"
  id: string                 // agent 无图时按 id 取默认头像（lib/bot-avatars）
  name: string               // alt / aria-label；human、room 无图时取首字母
  src?: string | null
  size?: "xs" | "sm" | "md" | "lg" | "xl"   // 20 / 28 / 36 / 48 / 64 px
  status?: AgentSignal       // 只对 agent 生效，右上角 SignalDot，带 surface 色描边
  className?
/>
```
形状（VI §6.1）：agent 圆形；human 圆角方形 30%；room 圆角方形 24%。human 图片加载失败回退首字母（保持 `ParticipantAvatar` 行为）。human / room 首字母底色用 `bg-accent-soft text-accent-text`。

### `StatusCapsule`
```ts
<StatusCapsule avatar={ReactNode} name: ReactNode status: ReactNode icon?: ReactNode actions?: ReactNode compact?: boolean className? />
```
头像 + 名称（13px/600）+ 一行状态（12px，`text-text-secondary`）+ 右侧可选操作；高 40（compact 32）；`rounded-full`、`bg-surface`、`border-border`。

### `NodeCordStatus`
```ts
<NodeCordStatus state: "static" | "sending" | "thinking" | "delivered" | "waiting" | "offline" size?: number className? />
```
Node·Cord 图形的状态动画（与 `docs/brand/botcord-vi/index.html` §8 一致），SVG 动画，墨色跟随 `currentColor`，信号节点用品牌色。`static` 用于钱包、签名等严肃场景。

### `Badge`
```ts
<Badge tone?: "neutral" | "accent" | "success" | "warning" | "danger" variant?: "soft" | "outline" size?: "sm" | "md" dot?: boolean icon?: ReactNode>{children}</Badge>
```

### `Card`
```ts
<Card variant?: "default" | "sunken" | "interactive" padding?: "none" | "sm" | "md" | "lg" as?: "div" | "section" | "article" | "button" ...rest />
```
`interactive` 带 hover 边框与 focus-visible 环；作为 button 时 `type="button"`。

### `EmptyState`
```ts
<EmptyState icon?: ReactNode title: ReactNode description?: ReactNode action?: ReactNode compact?: boolean />
```
居中、虚线边框可选（`bordered?: boolean`）；不使用渐变或模糊光斑。

### `Skeleton`
```ts
<Skeleton shape?: "line" | "block" | "circle" width? height? className? />
```
复用全局 `.dashboard-skeleton-block` 动画；`aria-hidden`。

## 新增 · 交互（批次 2）

### `Tabs`
```ts
<Tabs value onValueChange variant?: "segmented" | "underline" size?: "sm" | "md" items: { value: string; label: ReactNode; icon?: ReactNode; badge?: ReactNode; disabled?: boolean }[] ariaLabel: string />
```
`role="tablist"` / `role="tab"` / `aria-selected`，左右方向键切换并跳过 disabled。只负责标签条，内容由调用方按 value 渲染。

### `Menu`（基于 `@radix-ui/react-dropdown-menu`）
```ts
<Menu> <MenuTrigger asChild>…</MenuTrigger>
  <MenuContent align? side?> <MenuLabel/> <MenuItem icon? danger? onSelect disabled?/> <MenuSeparator/> </MenuContent>
</Menu>
```
样式：`bg-surface-raised`、`border-border`、`rounded-xl`、`shadow`；danger 项用 `text-danger`。

### `Tooltip`（重做现有 `ui/Tooltip.tsx`，基于 `@radix-ui/react-tooltip`）
```ts
<Tooltip content: ReactNode side? align? delay?: number>{trigger}</Tooltip>
```
深色气泡（浅色主题用 `bg-text-primary text-bg`，深色主题反之），12px，`rounded-lg`。

### `Switch` / `Checkbox`
```ts
<Switch checked onCheckedChange disabled? size?: "sm" | "md" label?: ReactNode />
<Checkbox checked: boolean | "indeterminate" onCheckedChange disabled? label?: ReactNode />
```
原生语义：Switch 用 `role="switch"` + `aria-checked`；Checkbox 用原生 input 或等价 aria。开启态用 `bg-accent`。

### `Field`
```ts
<Field label: ReactNode htmlFor? hint?: ReactNode error?: ReactNode required?: boolean>{control}</Field>
```
标签 12px/500 `text-text-secondary`，提示 12px `text-text-tertiary`，错误 12px `text-danger` 且 `role="alert"`。

### `Toast`
```ts
// store: useToastStore；调用：toast({ title, description?, tone?: "neutral" | "success" | "warning" | "danger", action?: { label, onClick }, durationMs? = 4000 })
<Toaster />   // 挂在 app/layout.tsx，右下角（移动端底部居中），最多 3 条，可手动关闭
```
`role="status"`（danger 为 `role="alert"`），进出场用 `--bc-duration-base`，遵守 reduced motion。

## 迁移约定

- `BotAvatar` / `ParticipantAvatar` 内部改用 `Avatar`，保留原 props 作为兼容层；新代码直接用 `Avatar`。
- 改到某个旧文件时，顺手把手写按钮 / 输入框 / 弹窗 / 徽章换成本库组件（Polar 规则）。
- 设计规范检查：`frontend/src/design-lint.test.ts` 扫描源码，禁止新增 sub-12px 字号、className 里的 hex / rgba、`fixed inset-0` 手写遮罩；存量列在白名单里，只减不增。

## 加载预览与浏览器图标

- `/design#loading` 展示 `BotCordLoader` 的 xs / sm / md 尺寸；“预览全页面加载”复用根路由等待态的 `BotCordLoadingScreen`，使用原生 dialog，支持 Esc、关闭按钮和焦点返回。
- favicon 使用固定浅色底板、深色连线和品牌色节点，不随系统深色模式翻转。浏览器标签背景独立于页面主题，底板保证选中、未选中和着色标签下的可见度。SVG 源文件与 `public/favicon.svg` 同步，ICO 提供 16 / 32 / 48px 回退。

## 类型覆盖补齐（2026-10-12）

完整模块盘点见 [COMPONENT-INVENTORY.md](COMPONENT-INVENTORY.md)，重新生成：`cd frontend && node scripts/audit-ui-components.mjs`。

| 类型 | 组件与契约 | 实际接入 |
|---|---|---|
| 原生下拉 | `Select`：原生 select props + `invalid`；保留 name/value/required/multiple 与手机系统选择器 | 8 个业务文件内原有 10 处 select 全部替换 |
| 带说明的单选 | `SingleSelect`：value/onChange/options/placeholder，option 支持 sublabel/disabled；方向键、Home/End，Esc 返回焦点 | 原 `DashboardSelect` 保留兼容导出，8 个调用文件自动复用 |
| 搜索多选 | `MultiSelect`：value 数组、onChange、options 或 groups、searchPlaceholder、emptyLabel、selectedLabel | 原 `DashboardMultiSelect` 保留兼容导出，3 个调用文件自动复用 |
| 搜索框 | `SearchInput`：原生 input props + 必填 label，受控 value/onChange | `SearchBar` 复用视觉，保留 300ms 防抖与卸载清理 |
| 单选按钮 | `Radio`：原生 input props，不含 type；调用者提供 label 和共享 name | 权限、回复策略等现有 radio 入口复用 |
| 行内反馈 | `Alert`：tone=neutral/success/warning/danger，title/children/actions；danger 用 alert，其他 status | 团队申请、添加 Agent、房间成员等错误提示 |
| 纯图标动作 | `IconButton`：必填 label，size=sm/md，danger，原生 button props | DialogShell 关闭按钮 |
| 抽屉外壳 | `DrawerShell`：与 DialogShell 相同，右侧全高布局；共用关闭、busy、键盘焦点与底栏 | 已有预览；复杂业务抽屉保留，避免改变嵌套确认与生命周期 |
| 数据表格 | `Table` / `TableHead` / `TableBody` / `TableRow` / `TableHeader` / `TableCell`；保留原生表格属性，Header 默认 scope=col | AdminCodesPage / AdminWaitlistPage；横向滚动由容器负责 |
| 指标卡 | `MetricCard`：value/label/detail/accent；原生 dl/dt/dd | 团队 Agent 管理抽屉的数量汇总 |
| 折叠区 | `Disclosure`：title + 原生 details props（open/onToggle） | 运行错误弹窗的原始详情 |

`SingleSelect` 与 `MultiSelect` 透传 id、aria-label、aria-labelledby、aria-describedby、aria-invalid，可与 Field 组合。它们用于交互选项，**不提交隐藏表单值**；需要原生 form name/value 时用 Select。

### 已有组件的预览补齐

`/design` 增加分类导航与演示，覆盖组件库 43 个组件模块（含根布局的 ConfirmDialog / Toaster 宿主）。新增可交互确认框、图片预览，以及 UnreadBadge、CopyableId、MarkdownContent、AttachmentItem、SystemMessageNotice、MarketingButton、MarketingCard、SectionHeading、CordField、TypewriterCode 的示例。

### 仍需分批迁移的业务类型

- **消息与流式内容**：MessageBubble、StreamBlocksView、ToolResultContent、MessageComposer、MentionChip、ReplyQuoteBlock。继续组合 MarkdownContent、AttachmentItem、Avatar、Badge 等原语，业务协议、流式状态、编辑器和 IME 行为留在 dashboard。
- **列表与业务身份**：RoomList、ContactList、ExploreEntityCard、CompositeAvatar、AgentIdentity。保留列表行为；基础头像和计数优先用 Avatar / UnreadBadge。
- **出席状态与运行状态**：PresenceDot 的 busy / away / working 是业务出席状态，SignalDot 的 thinking / replying / waiting 是运行状态。不能直接改名替换；后续单独制定映射，避免把“忙碌”显示成“失败”。
- **复杂弹窗与抽屉**：TopicDrawer、BotDetailDrawer、AgentManageDrawer 等仍有业务动画、嵌套确认、焦点和生命周期逻辑。DrawerShell 已提供统一基础；迁移时必须保留这些行为。
- **设备表格、文件上传与文档阅读**：设备表格包含内联编辑和展开行，文档阅读有媒体与附件安全边界；本轮不改其行为。原生文件输入由 Input 接收原生 props，上传网络状态留在业务层。
- **营销专用布局与动画**：Hero、3D 场景和功能演示继续放在营销目录，组件库提供品牌、卡片、标题和 CTA。

本轮完成类型覆盖、共享实现提取和代表性业务接入，不代表所有裸 button/input、手写弹窗和旧视觉样式已迁移完毕。新增页面优先用上表的组件，存量按业务行为逐步迁移。
