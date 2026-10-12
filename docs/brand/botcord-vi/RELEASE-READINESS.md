# UI 组件库迁移基线 v1

日期：2026-10-12。状态：基础组件与接口作为首批迁移基线；不是全站迁移完成，也不是生产发布。

## 1. 视觉决策

本轮由真实的“邀请码管理”页面验证组件组合，而不只看组件陈列。入口 `/design/pilot`，仅开发与 Vercel 预览环境开放；页面使用内存 API 适配器，不读取或修改真实管理数据。

| 项目 | 确定规则 |
| --- | --- |
| 字体 | Geist + 中文系统回退；代码 / ID 用 Geist Mono；不新增网络字体 |
| 字重 | 正文 400，标签和按钮 500，标题 600 |
| 层级 | 页面标题 28px；表单分组 18px；正文 14px；说明 13px；标签 12px |
| 控件密度 | 桌面标准控件 40px、紧凑按钮 32px；触控设备主要操作区域至少 44px |
| 形状 | 按钮 / 输入 8px，卡片 / 菜单 12px，弹窗 16px |
| 信息颜色 | 正文 primary，说明 secondary；tertiary 仅占位 / 禁用，不用透明度淡化必需信息 |
| 主操作 | 创建表单打开后，表单提交是唯一主操作，页头入口降为 secondary |
| 长内容 | 表格在自身区域滚动；完整标注换行；弹窗内容内部滚动，不能扩宽页面 |
| 状态 | 加载用统一 Logo；错误用 Alert；有效 / 已撤销用 Badge；空列表用 EmptyState |

截图见 `screenshots/pilot-desktop-dark.png`、`pilot-mobile-light.png`、`pilot-nested-mobile.png`。页面中文沿用原管理模块；未扩展其语言范围。

## 2. 组件接口与覆盖规则

公开 API 以 `COMPONENTS.md` 和导出的 TypeScript props 为准。以下规则从本基线起保持兼容：

- Button 保留 `variant`、`size`、`loading`，默认 `type="button"`；表单提交必须显式 `type="submit"`。loading 阻止点击，但业务层仍负责请求去重。
- Input / Textarea / Select 保留原生表单属性和 ref。Field 负责 label、id、描述关联和错误态。不要吞掉调用方的 aria 属性。
- SingleSelect / MultiSelect 保留 `value` + `onChange`；Select 保留原生 change event。不能为追求表面统一悄悄改变回调参数。复杂选择器不承诺原生 form 序列化，需业务层组装数据。
- DialogShell / DrawerShell 由挂载控制显示，`onClose` 在退场后执行；busy 禁止用户关闭。内部选择器先消费 Esc，下一次 Esc 才关闭弹窗。嵌套弹窗关闭前继续锁定页面滚动。
- Table 保留原生 table 属性和子元素，外层有可聚焦滚动容器；业务提供有意义的 aria-label，不依赖 table 必须是父节点的直接子元素。
- API 请求、校验规则、排序 / 分页、上传、身份权限和业务状态保留在业务层。
- `className` 用于外部布局（宽度、网格位置、外边距）。不得覆盖字体、语义颜色、焦点环、触控最小尺寸、disabled 或 loading 行为。现有样式覆盖只作迁移兼容，不作为新用法。
- 只使用显式支持的扩展口，例如 DialogShell 的 size、bodyClassName、footer，以及选择器的 panelClassName；改变组件内部外观先加有名称的 variant，并补示例和验证。
- 新增可选 props 可兼容扩展；删除 / 改名、默认行为改变、事件参数改变必须提供迁移说明和兼容层，不一次性破坏所有调用方。

## 3. 验收范围与证据

- 单元 / 交互测试：邀请码创建 payload 不变、失败保留输入、pending 请求去重、取消与撤销确认、列表失败重试、提交后焦点返回；嵌套选择器 Esc、多个弹窗的页面滚动锁、软键盘可见视口定位。
- 浏览器：1440px 桌面、320 / 375 / 430px 触控模拟；浅 / 深主题、长标注、局部表格滚动、创建、撤销取消、120 个选项、弹窗内选择器、分层 Esc；确认没有发出 `/api/admin/` 请求。
- 预览场景：正常 / 空列表 / 慢请求 / 加载失败 / 提交失败可切换。生产环境访问验收页必须返回 404，有路由测试覆盖。
- 本次修复了组合暴露的问题：Esc 同时关闭内外层；动画残留 transform 导致固定定位错误；提交期间入口禁用导致焦点恢复失败。
- 构建与测试的本轮实际结果记录在 PR 验证说明。预览数据测试不等于真实管理员权限或后端集成验收。

## 4. 可迁移范围与后续顺序

| 分组 | 决定 |
| --- | --- |
| Button / IconButton、Input / Textarea / Field / Select、Card / Badge / Alert / EmptyState / Skeleton / Loader、Table | 采用本基线，开始按完整页面迁移 |
| Tabs / Menu / Checkbox / Radio / Switch / Tooltip / Toast、DialogShell / DrawerShell、SingleSelect / MultiSelect | 接口保持稳定；复用现有行为，每个页面补组合与触控验证；Tooltip 不能承载必需信息 |
| 消息流、富文本 / 编辑器、文件上传、复杂 Agent 抽屉、PresenceDot | 暂不按通用原语批量替换；保留业务语义，独立迁移 |

先迁移普通设置和管理页面，再迁移对话框 / 抽屉较多的页面，最后处理消息和编辑器。每批保留权限与 API、补行为测试、验证浅深主题与手机宽度，并更新组件盘点。设计基线违规数只能下降。

真实 iOS / Android 软键盘、横屏刘海安全区和生产管理员完整链路仍需对应设备 / 账号验收。它们是扩大上线范围前的待验项，不记为“已通过”。无需为此阻塞普通页面的代码迁移；不要将本基线描述为“全组件已完成真机适配”。
