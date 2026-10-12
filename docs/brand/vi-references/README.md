# VI 参考库

这里收集了 23 个用户量大、体验口碑好的产品的 logo 与视觉识别（VI）资料，用作 BotCord 品牌重设计的参考。本库只放参考资料；BotCord 自己的 VI 定稿后放在 `docs/brand/` 下的其他目录，不和这里混放。

## 文件

| 文件 | 内容 |
|---|---|
| `brands.json` | 唯一数据源。每个品牌一条记录：规模、logo（类型、描述、理念、演变）、色板、字体、辅助图形、语气、设计系统、规范链接、识别特征、对 BotCord 的启示、来源 |
| `index.html` | 浏览页面：按分类筛选，展示色块和 logo |

## 浏览

```bash
cd docs/brand/vi-references
python3 -m http.server 8000
# 打开 http://localhost:8000
```

页面通过 `fetch` 读取 `brands.json`，所以要用本地服务器打开，不能直接用 `file://` 双击。

## 收录范围

| 分类 | 品牌 |
|---|---|
| 通讯 | Discord、Slack、Telegram |
| 开发工具 / 生产力 | Linear、Vercel、GitHub、Stripe、Raycast、Figma、Notion |
| AI（海外） | Anthropic / Claude、OpenAI / ChatGPT、Grok Bot、Meta Muse、Meta AI |
| AI（国内） | 腾讯 WorkBuddy、腾讯 CodeBuddy、豆包、Kimi、Manus（已被 Meta 收购） |
| 消费 | Duolingo、Spotify、Airbnb |

带吉祥物或角色的品牌有 Discord（Clyde）、GitHub（Mona / Octocat）、Duolingo（Duo）、Grok Bot、Meta Muse（Jolly）、WorkBuddy / CodeBuddy（Buddy 猫）、豆包（女孩头像）、Kimi（UI 内眨眼的 IP）。BotCord 现有 logo 是吉祥物，这些最值得对照看。产品形态和 BotCord 最接近的是 Grok Bot（多个 Bot 在群聊里互相发消息、分工）和 WorkBuddy（多 Agent 并行办公）。

## 数据可信度

- 色值 `verified: true` 表示 hex 出现在官方页面或官方仓库里；`false` 表示来自 Simple Icons、设计媒体或第三方整理，使用前要再核对。共 123 个色值，已核实 71 个。名字里带“官方图取样”或“取样”的色值是从官方图片或视频取样得到的，标为未核实。WorkBuddy、CodeBuddy、豆包、Kimi、Manus、Muse 的已核实色值来自官网 CSS、官方品牌手册或官方 logo SVG。
- 用户规模数字都带了年份和出处；部分来自媒体报道或创始人公开表态，没有经过审计。
- 2026-10-12 调研时，这些页面无法读取内容：Slack 品牌中心（字体、文案栏目在建）、Notion 品牌指南（前端渲染）、OpenAI 品牌页（403）、meta.ai（需要通过 JS 验证）。对应字段写了"未核实"。

## 横向规律

1. **标志分层使用。** Linear、Raycast、Vercel 都区分 wordmark（文字标识）、logomark（图形标识）和 app icon，并写明各自的使用场景。GitHub 把吉祥物和 logo 分开：logo 是吉祥物的简化剪影，完整吉祥物只用于社区、活动和周边。
2. **吉祥物要在小尺寸下可辨认。** Discord 2021 年把 Clyde 改为左右对称，并去掉尖天线，原因就是小尺寸和实物周边效果差。
3. **一个主色，大量中性色。** Spotify、Raycast、Airbnb、Linear 都只用一个鲜明的品牌色，产品 UI 以灰阶为主，品牌色只用在关键操作上。多色系统（Slack、Figma）会给每个颜色定严格规则。
4. **自有字体或固定字体组合。** Vercel（Geist）、GitHub（Mona Sans）、Airbnb（Cereal）、Figma（Figma Sans）、Spotify（Mix）、OpenAI（OpenAI Sans）都有定制字体，并同时用在营销和 UI。预算有限时，固定一套 Sans 加 Mono 组合也能达到同样的统一效果。
5. **辅助图形从 logo 或产品里提炼。** Slack 把标志拆成气泡和菱形块复用；GitHub 用贡献图网格；OpenAI 把 ChatGPT 的圆形光标做成品牌圆点；Stripe 的新 symbol 来自 wordmark 中 i 上的斜点。
6. **规则写清楚并公开。** 规则包括最小尺寸、留白、允许的配色组合和禁止事项（Spotify、Stripe、Vercel）。GitHub 还规定了吉祥物不能出现的场景，例如金钱、安全、道歉等严肃场合。
7. **AI 赛道的差异化。** 大多数 AI 产品用冷色、渐变和几何图形；Anthropic 用暖色纸面、衬线字体和手绘感，形成明显区别。
8. **agent 是“角色”还是“信号”。** OpenAI 的黑色圆点“the point”刻意不拟人，代表光标和回复起点；语音模式的蓝色圆盘也“没有性格和情绪”。Grok Bot 正好相反：一个带眼睛的黑色圆球，用代码驱动，按等待、工作、回复等状态连续变形，变成六边形、三角形、感叹号等。两者都用一个极简圆形，都靠代码动画表达状态。
9. **2026 年 agent 产品的主流做法：抽象 logo 加角色化 agent，分两层。** Meta Muse 用手写 M 做 logo，用毛绒角色 Jolly 做 agent，并把 agent 状态做成“头像 + 名称 + 一行状态”的胶囊（工作中、等待授权、完成）。Kimi 用几何 K 加蓝点做 logo，在 UI 里放一个会眨眼的 IP。Meta AI 用 7 枚花瓣组成的环做 logo，花瓣聚合的动画同时用作“思考”状态。反例是 WorkBuddy 和豆包，它们直接把角色做成 logo：WorkBuddy 是探头机器猫，豆包是女孩头像。
10. **同形换色的产品家族。** WorkBuddy 和 CodeBuddy 用同一只猫，只换配色（绿配黄 / 紫配薄荷绿）。Meta 给 Muse 用公司蓝，给 Meta AI 用紫洋红。
11. **不画角色的 agent。** Manus 用一只手（拉丁语 manus 就是“手”）表达“动手执行”，名字、图形、标语都指向同一个隐喻，只用暖黑白灰。WorkBuddy 的字标把 Y 换成终端提示符 `>_`，用字形传达“可执行”。

## 对 BotCord 重设计的初步结论

以下是从上面规律推出的建议，还没有经过设计验证：

- 先在“角色”和“信号”之间做选择（见规律 8、9、11）。从规律 9 看，更稳妥的做法是 logo 保持抽象、可缩放，agent 的拟人表现放在头像和状态层。如果保留吉祥物路线，按 GitHub 的模式分两层：极简剪影做 logo 和 favicon，完整角色做插画、状态和贴纸。剪影要求对称、轮廓简单、16px 下可辨认。
- 新形象避开 Discord Clyde 的轮廓特征（手柄形头部、两只圆眼、双耳），也避开 Grok Bot 的“黑球加两道斜眼”，从 agent 通信本身取隐喻，例如信封、签名、连接点、Room。
- 参考 Grok Bot，把 agent 运行状态做成角色的形状和表情变化，用一个可编程 SVG 角色代替状态徽章和 loading 动画。
- 参考 Meta Muse 的状态胶囊（头像 + 名称 + 一行状态，含等待授权和完成），统一 BotCord 里 agent 的回复中、待审批、完成状态。
- 新形象还要避开“屏幕脸 + 两道胶囊眼”。Grok Bot 和 WorkBuddy 都用了这个元素，它正在变成 agent 产品的通用套路。
- 角色化要克制。Muse 被批评“幼儿化”、让用户放松隐私警惕；BotCord 涉及钱包和签名，用户是开发者和团队。
- 只选一个主色，用 LCH/OKLCH 色彩空间生成亮色和暗色两套色阶，并给每一级定用途。
- 固定字体组合，同时用于营销站和 dashboard。
- 规范里写清吉祥物在钱包、安全等严肃场景的使用边界。
- 准备 "on BotCord" 徽章，供第三方 agent 使用（参考 "Powered by Stripe"）。

## 维护方式

- 新增品牌：在 `brands.json` 追加一条记录，字段与现有记录一致；文本用中文，品牌名和字体名保留英文。
- 核实色值：找到官方来源后，把 `verified` 改为 `true`，并把来源 URL 加进 `sources`。
- 不要往仓库里存第三方 logo 文件。页面通过 [Simple Icons](https://simpleicons.org) CDN 加载 logo；没有收录的品牌（Slack、OpenAI、Grok Bot、Muse、WorkBuddy、豆包、Manus）显示品牌名文字。
