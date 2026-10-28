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
Node·Cord 图形的状态动画（与 `docs/brand/botcord-vi/index.html` §8 一致），SVG 动画，墨色跟随 `currentColor`，信号节点用品牌色。`static` 用于钱包、签名等严肃场景的状态展示；这些场景的数据加载仍用 `BotCordLoadingBlock`。

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
`MenuItem asChild` 接收一个链接元素，保留 href、ref 和菜单事件；图标放在链接内部，不同时传入 `icon`。没有 `icon` 时直接透传 children，避免 Radix Slot 收到多个子节点而崩溃。

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

- `/chats` 代码下载与首次鉴权等待复用 `BotCordLoadingScreen`，使用 `min-h-dvh bg-bg` 全屏居中，和根路由等待态保持一致；就绪后直接展示应用，不添加人为延时。该画面在 HTML 返回后生效，不替代系统启动图。

- 区块级加载（面板、列表、弹窗内容）用 `BotCordLoadingBlock`，所有屏宽都显示品牌动效，钱包、转账页面同样适用（转账专用动效如有需要，在组件库中设计）；按钮内的提交 / 刷新状态仍用 `Button loading` 或行内 spinner。
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
| 纯图标动作 | `IconButton`：必填 label，size=sm/md，danger，原生 button props；切换类动作传 aria-pressed 显示选中态 | DialogShell 关闭按钮 |
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

### 排版与可读性（2026-10-12）

- 字体由 `next/font` 加载 Geist / Geist Mono；中文依次回退 PingFang SC、Noto Sans SC、Microsoft YaHei。字体加载变量与 Tailwind 别名分开命名，避免自引用。
- `type-heading-1/2/3`、`type-body-sm`、`type-caption` 直接引用生成的 VI 字体 token；新增规格先更新 token 源文件。
- 选项说明、表单提示使用普通字体及 `text-text-secondary`，不降低透明度。等宽字体留给代码和标识符。
- 加载文案不强制大写、不额外增加字距；按钮和输入框使用 8px 圆角。
- `/design#typography` 提供中英文、数字及标识符样张。业务页面中尚未迁移的局部样式不代表已完成全站 VI 对齐。

### 移动端约束与验证（2026-10-12）

- 粗指针设备上，Button、IconButton、MenuItem、Tabs 及带标签的 Checkbox / Switch 最小点击区域为 44px；表单控件最小高度为 44px，输入文字最小 16px。
- SingleSelect / MultiSelect 在不超过 640px 的触控视口中使用底部选项面板，监听 visualViewport 的 resize / scroll，以避开软键盘；仍为非模态控件，点击外部关闭。
- Tabs 支持自身横向滚动；Table 默认包含可聚焦的横向滚动区域，保留内部 table 语义。为数据表传入有意义的 aria-label。
- DialogShell 限制动态视口高度、允许底部操作换行；DrawerShell 与 Toast 避让底部安全区。
- Tooltip 不能承载完成任务所必需的信息；移动端必须提供可见标签或独立说明。无标签开关、Radio 的调用方须保证足够间距及可点击标签。
- 已验证 Chromium 触控模拟 320 / 375 / 430px：页面无横向溢出、按钮点击区域、选择器选中 / 搜索、抽屉打开关闭。单元测试覆盖软键盘视口变化。真实 iOS / Android 键盘、横屏刘海安全区及复杂业务页面仍需真机验收。

## 迁移基线

组件成熟度、稳定接口、样式覆盖限制、真实页面试点和验收边界见 [RELEASE-READINESS.md](./RELEASE-READINESS.md)。


## 全站迁移新增组合能力

| 组件 / 变体 | 契约与用途 |
| --- | --- |
| Button `row` | 多行列表动作，无固定高度；aria-pressed / aria-selected / aria-current=page / data-active=true 表示选中；调用方只补布局 |
| Button `inline` | 正文中的行内动作，保留文字流；不用于常规表单提交或工具栏主操作 |
| LinkButton | Button 同源视觉，href + 原生 anchor attrs/ref；站内用 Next Link，保留修饰键、新标签和 target/rel |
| Input / Textarea `composer` | 嵌入式无边框输入，无内边距和固定高度；保留原生事件/ref，业务持有自动高度和IME逻辑 |
| Input / Textarea `message` | 消息覆盖层配套，px-3 py-2、min-h-11；与高亮层使用相同行高和字体 |
| Checkbox `wrapLabel=false` | 放在已有 label 内，避免嵌套标签；默认 true 兼容独立标签 |
| Card `as=li/dl` | 保留列表/术语表语义；interactive支持aria-checked/pressed/selected/current选中 |
| Alert `ref` | 暴露HTMLDivElement给已有错误提示动画，不改变live role |
| DialogSurface | 无内置动画和内边距的组合壳；overlayRef/panelRef由业务动画使用；统一Esc/焦点/滚动锁，busy/closing阻止关闭；modal=false用于桌面非模态检查器 |
| DismissLayer | 既有响应式导航的关闭遮罩，保留HTMLButtonElement ref和onClick；无操作按钮高度；调用方负责几何位置、Esc与焦点 |
| SwipeableRow | 行内左滑操作：触屏横向拖动露出每项72px宽、整行高的操作色块，纵向手势保持原生滚动；open/onOpenChange受控，必填label给“更多”按钮，Esc和点外部关闭；actions为{label,onClick,disabled,className}，className只放语义色块（如bg-accent text-on-accent）|

新表单优先 DialogShell / DrawerShell；仅在必须保留旧业务动画生命周期时使用 DialogSurface。动画结束后清除无意义的 identity transform，避免改变内部 fixed 元素定位。所有表单提交按钮显式写 `type="submit"`，共享 Button 默认 `type="button"`。

### CopyableId 复制反馈

保留 `value` / `className`，新增可选 `copyLabel`、`copiedLabel`、`copyFailedLabel`。复制图标常驻，成功后变为 Check；结果通过 status 播报，失败不显示成功。触屏点击区域至少 44px。

## Team 模式组件（2026-10-13）

`components/team/` 复用已有组件；以下是从团队页面提取、按 VI 新设计后放入组件库的组件。预览见 `/design#team`。

| 组件 | 契约 | 团队页面接入 |
| --- | --- | --- |
| `IconTile` | tone=accent/neutral，size=sm 36 / md 44 / lg 64；子元素为 lucide 图标，尺寸由组件统一；整体 aria-hidden | 组织切换、空间卡片、Agent 入口、新建 Agent、空团队引导、邀请落地页 |
| `PresenceIndicator` | status=offline/online/busy/away/working，size=xs 6 / sm 8 / md 10 / lg 12；`label` 给出可访问名称，否则 aria-hidden；`overlay` 放在相对定位头像的右下角；静态，无循环动画；未知状态按 offline 显示 | Agent 目录头像与状态行；dashboard `PresenceDot` 也改为渲染它 |
| `ChoiceCard` | 原生 radio 属性 + title / description；选中 accent-soft 背景，disabled 降低不透明度；调用方提供 fieldset + legend | 申请权限、批准申请时选择角色 |
| `Chip` | 紧凑描边标签；as=span/li，align=center/start，可选 icon；传 `onRemove` 时必须给 `removeLabel`，`removing` 显示加载并禁用 | 房间 Agent 与我的能力、Agent 管理抽屉的按人回复规则 |
| `ListGroup` / `ListGroupItem` | 描边圆角 ul，divided 默认 true；Item 统一 px-3 py-2.5，align=center/start | 待处理申请列表、房间可添加成员 / Agent |
| `PageHeader` | title + eyebrow / description / icon / actions；align=start/center；level 1 渲染 h1（VI h2 28px），level 2 渲染 h2（VI h3 22px）；eyebrow 不转大写、不加字距 | 团队空间页标题、空团队引导、组织邀请落地页 |
| Alert `tone="accent"` + `icon` | accent 表示“需要你处理”，文字保持主色，图标用 accent-text；`icon` 替换默认图标 | Agent 页待处理申请横幅 |

同时改为复用：邀请链接状态用 `Badge variant="outline"`，用户 ID 用 `CopyableId`。团队目录中的 `neon-cyan`、`glass-*`、`deep-black` 旧类名已换成语义类（`text-accent-text`、`border-border`、`bg-surface`、`bg-bg`）。

出席状态（PresenceIndicator）表示 Agent 是否在线、忙碌；运行状态（SignalDot）表示思考、回复、等待授权。两者含义不同，不能互换。

### Message reaction primitives (scheme A)

- `AgentResponseAvatar { id, name, src?, state, animate? }`：28px agent 头像，右下角显示消息处理状态。`processing` 复用 Avatar thinking 呼吸点，`replying` 复用外圈动画；`ignored` 为灰色虚线圈，`no_reply` 为减号，`completed` 为对勾，`unknown` 不加标记。其余终态/排队状态使用 lucide 16px 角标。这里不表示在线状态。
- `AgentReactionStrip { items, label, moreLabel, onSelect }`：传入按优先级排序的头像条目（含 label/state/animate）。最多显示 8 个；多余用 +N 折叠，窄消息按可用宽度进一步收起。桌面方向键/Home/End 切换、Enter 打开；手机整行至少 44px，打开全部列表。折叠项中有失败或中断时 +N 带警示点。
- `ReactionPanel { anchor, title, closeLabel, onClose, children }`：组合 DialogSurface，桌面相对触发元素定位，手机底部面板。负责边界定位、Escape、焦点返回和滚动锁；dashboard 调用方用 withDashboardOverlayPortal 包装。
- `Avatar` / `SignalDot` 新增 `animate?: boolean`，默认 true。false 保留状态形状和语义但关闭动效。消息列表只为最新活动消息的一个 Agent 开启动画，其他头像静态。系统 reduced-motion 仍关闭全部循环。

真实组件示例：`/design#agent-reactions`。消息轮询与重试仍由业务层负责；前端优先使用 response_state，历史 no_reply 不推断为 ignored 或执行后静默。

### MessageActionPopover · 消息长按操作

`MessageActionPopover` 接收 `anchorRef`、`label`、`actions: { id, label, icon, onSelect, disabled? }[]`、`onClose`；由调用方控制挂载。跟随主题的浮层内使用图标在上、文字在下的网格，每行最多五项，多行间有分隔线；箭头指向消息。优先显示在消息上方，空间不足时翻转，并避让 visualViewport。支持点外部、Escape 关闭和方向键导航；关闭时恢复消息焦点。只展示业务实际提供的操作。

该组件复用 VI 的 `surface-raised`、`text-primary`、`surface-sunken`、`border` 语义类；箭头复用浮层背景和边框。标签使用 `type-caption`，图标 24px / 1.75 线宽，点击区域至少 44px。浅色主题使用白底深色文字，深色主题跟随标准弹层颜色，不直接引用基础色阶。

### UnreadBadge 清除反馈

`burstOnClear?: boolean` 默认 false。启用时保持组件挂载并把 `count` 设为 0：立即移除未读数字，播放 220ms 的环形破裂和四个微粒后消失。纯装饰、不可交互，reduced motion 下立即隐藏。网络请求和失败恢复由业务层处理。
