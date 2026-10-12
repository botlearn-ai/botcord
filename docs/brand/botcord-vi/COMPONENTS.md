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
