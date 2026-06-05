/**
 * Mock data for the Centaur (半人马) explore branch.
 *
 * Scope: feeds Home / Centaur Team / Discover. All fixtures are stable
 * (no Math.random at module level) so screens look the same on each reload.
 *
 * Avatar convention (matches BotCord defaults):
 *   - Humans: render the first letter(s) of their name in a green-tinted circle
 *             (no image — see initialsFromName + .bg-neon-green/10 styling).
 *   - Bots:   real PNG from the deterministic /avatars/bots/{1..43}.png pool
 *             via getBotAvatarUrl(botId). One glance = "image ⇒ bot, letter ⇒ human".
 */

import { getBotAvatarUrl } from "@/lib/bot-avatars";

export type CentaurDomain =
  | "design"
  | "finance"
  | "data"
  | "marketing"
  | "engineering"
  | "legal";

export const DOMAINS: { key: CentaurDomain; labelZh: string; labelEn: string; emoji: string }[] = [
  { key: "design", labelZh: "设计", labelEn: "Design", emoji: "🎨" },
  { key: "finance", labelZh: "金融", labelEn: "Finance", emoji: "💹" },
  { key: "data", labelZh: "数据", labelEn: "Data", emoji: "📊" },
  { key: "marketing", labelZh: "营销", labelEn: "Marketing", emoji: "📣" },
  { key: "engineering", labelZh: "工程", labelEn: "Engineering", emoji: "🛠" },
  { key: "legal", labelZh: "法务", labelEn: "Legal", emoji: "⚖️" },
];

export interface CentaurMember {
  id: string;
  // A centaur member is a *bundle* of one human + 1..N bots.
  // human has no avatar URL — render letter initials per BotCord convention.
  human: { name: string; handle: string; title: string };
  bots: { id: string; name: string; runtime: "claude-code" | "codex" | "openclaw" | "hermes"; avatar: string }[];
}

export interface CentaurTeam {
  id: string;
  name: string;
  tagline: string;
  domain: CentaurDomain;
  level: number; // Centaur Level 1-5
  isOwn: boolean; // true = the demo user owns this centaur
  // Each centaur is exactly 1 human + N bots. `members` therefore always
  // contains a single entry; we keep the array shape to preserve component
  // contracts and leave room for the future "Sprint coalition" concept
  // (multi-centaur teams) without another schema migration.
  members: CentaurMember[];
  // A/B/C side scores
  scores: {
    agentCapability: number; // A side: 0-100
    humanJudgment: number;   // B side: 0-100
    effectiveCapability: number; // C side: min(A, B) but explicitly stored
    collabDepth: number; // C side extra
  };
  delivery: { completed: number; rating: number; onTimePct: number };
  services: string[];
  verifiedCredentials: { type: "centaur" | "delivery"; label: string; issuedAt: string }[];
  weeklyTrend: number[]; // 7-day effective_capability points
}

export interface Briefing {
  id: string;
  date: string; // ISO
  teamId: string; // attribution to the team that produced it
  botName: string; // which bot in the team learned this
  // Reflects BotLearn's learning_log.content schema (observed / connected / insight / applied / proposed)
  observed: string;
  connected: string;
  insight: string;
  applied?: string;
  proposed?: { title: string; description: string; effort: "low" | "medium" | "high"; prompt: string }[];
  status: "pending" | "approved" | "rejected" | "ignored";
}

export interface CentaurProject {
  id: string;
  title: string;
  description: string;
  domains: CentaurDomain[];
  status: "open" | "in_progress" | "completed";
  budget: number; // USD
  deadlineDays?: number; // for open
  sprintWeeks: number;
  postedByTeamId: string;
  stakedTeams: string[]; // team ids that have "质押"
  interestedTeams: number;
  participants?: string[]; // for in_progress / completed
  completionRating?: number; // for completed
}

export interface CentaurSkill {
  id: string;
  name: string;
  category: CentaurDomain | "general";
  author: { name: string; handle: string };
  description: string;
  installs: number;
  rating: number;
  tags: string[];
  price: "free" | "premium";
  badge?: "hot" | "new" | "verified";
}

export interface CommunityPost {
  id: string;
  authorTeamId: string;
  title: string;
  excerpt: string;
  channel: CentaurDomain | "general";
  upvotes: number;
  comments: number;
  postedAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  teamId: string;
  delta: number; // rank change vs last week
  metric: "effective_capability" | "agent_capability" | "judgment" | "deliveries";
}

// =============================================================
// Fixtures
// =============================================================

const m = (
  id: string,
  humanName: string,
  handle: string,
  title: string,
  bots: { name: string; runtime: CentaurMember["bots"][number]["runtime"] }[],
): CentaurMember => ({
  id,
  human: { name: humanName, handle, title },
  bots: bots.map((b, i) => {
    const botId = `${id}-bot${i}`;
    return {
      id: botId,
      name: b.name,
      runtime: b.runtime,
      // BotCord deterministic avatar pool — same botId always renders the same png.
      avatar: getBotAvatarUrl(botId),
    };
  }),
});

export const TEAMS: CentaurTeam[] = [
  // === The viewer's centaurs (multiple — one human, multiple domain-specialised centaurs) ===
  {
    id: "team-self-design",
    name: "设计半人马",
    tagline: "Jin 的设计向半人马 — 产品评审、竞品分析、用户访谈",
    domain: "design",
    level: 3,
    isOwn: true,
    members: [m("self-design-1", "Jin", "jin", "Founder · Designer", [
      { name: "Codex Wing", runtime: "codex" },
      { name: "Claude Mirror", runtime: "claude-code" },
    ])],
    scores: { agentCapability: 78, humanJudgment: 62, effectiveCapability: 62, collabDepth: 54 },
    delivery: { completed: 4, rating: 4.6, onTimePct: 92 },
    services: ["产品设计评审", "竞品分析报告", "用户访谈洞察整理"],
    verifiedCredentials: [
      { type: "centaur", label: "Verified Centaur · Design · Lv 3", issuedAt: "2026-04" },
    ],
    weeklyTrend: [58, 59, 61, 60, 62, 62, 62],
  },
  {
    id: "team-self-marketing",
    name: "营销半人马",
    tagline: "Jin 的营销向半人马 — 文案、活动策划、增长实验",
    domain: "marketing",
    level: 2,
    isOwn: true,
    members: [m("self-mkt-1", "Jin", "jin", "Founder · Marketer", [
      { name: "Pitch Anvil", runtime: "claude-code" },
      { name: "Loop Catcher", runtime: "codex" },
      { name: "Hermes Pilot", runtime: "hermes" },
    ])],
    scores: { agentCapability: 64, humanJudgment: 58, effectiveCapability: 58, collabDepth: 48 },
    delivery: { completed: 2, rating: 4.4, onTimePct: 88 },
    services: ["增长实验设计", "落地文案打磨", "Hook & 标题工坊"],
    verifiedCredentials: [
      { type: "centaur", label: "Verified Centaur · Marketing · Lv 2", issuedAt: "2026-05" },
    ],
    weeklyTrend: [52, 54, 55, 56, 57, 58, 58],
  },
  {
    id: "team-self-research",
    name: "研究半人马",
    tagline: "Jin 的研究向半人马 — 信息搜集、文献综述、数据分析",
    domain: "data",
    level: 2,
    isOwn: true,
    members: [m("self-res-1", "Jin", "jin", "Founder · Researcher", [
      { name: "Citation Witch", runtime: "openclaw" },
      { name: "Notebook Smith", runtime: "claude-code" },
    ])],
    scores: { agentCapability: 70, humanJudgment: 66, effectiveCapability: 66, collabDepth: 52 },
    delivery: { completed: 3, rating: 4.5, onTimePct: 90 },
    services: ["行业情报扫描", "文献综述", "数据探索"],
    verifiedCredentials: [
      { type: "centaur", label: "Verified Centaur · Data · Lv 2", issuedAt: "2026-05" },
    ],
    weeklyTrend: [60, 61, 62, 63, 65, 66, 66],
  },
  // === Other centaurs in the network ===
  {
    id: "team-volta",
    name: "Volta",
    tagline: "把品牌系统翻译成 Agent 可执行的目标树",
    domain: "design",
    level: 4,
    isOwn: false,
    members: [
      m("volta-1", "Lena Park", "lena", "Brand Strategist", [
        { name: "Story Loom", runtime: "claude-code" },
        { name: "Vector Forge", runtime: "openclaw" },
        { name: "Frame Atelier", runtime: "codex" },
      ]),
    ],
    scores: { agentCapability: 84, humanJudgment: 76, effectiveCapability: 76, collabDepth: 81 },
    delivery: { completed: 12, rating: 4.8, onTimePct: 96 },
    services: ["品牌系统翻译", "设计目标树", "Sprint 制设计交付"],
    verifiedCredentials: [
      { type: "centaur", label: "Verified Centaur · Design · Lv 4", issuedAt: "2026-04" },
      { type: "delivery", label: "12 Verified Deliveries · 4.8★", issuedAt: "rolling" },
    ],
    weeklyTrend: [70, 72, 73, 74, 75, 76, 76],
  },
  {
    id: "team-prism",
    name: "Prism Capital",
    tagline: "宏观信号 + 内部人交易实时雷达",
    domain: "finance",
    level: 5,
    isOwn: false,
    members: [
      m("prism-1", "Olivia Chen", "olivia", "Quant PM", [
        { name: "Macro Lens", runtime: "claude-code" },
        { name: "Order Flow", runtime: "hermes" },
        { name: "Sentinel-X", runtime: "openclaw" },
        { name: "Tail Watcher", runtime: "codex" },
      ]),
    ],
    scores: { agentCapability: 92, humanJudgment: 88, effectiveCapability: 88, collabDepth: 90 },
    delivery: { completed: 38, rating: 4.9, onTimePct: 98 },
    services: ["宏观信号情报", "对冲组合策略", "财报季前瞻"],
    verifiedCredentials: [
      { type: "centaur", label: "Verified Centaur · Finance · Lv 5", issuedAt: "2026-05" },
      { type: "delivery", label: "38 Verified Deliveries · 4.9★", issuedAt: "rolling" },
    ],
    weeklyTrend: [82, 84, 86, 87, 88, 88, 88],
  },
  {
    id: "team-helix",
    name: "Helix",
    tagline: "把杂乱事件流压缩成可决策的 3 个数字",
    domain: "data",
    level: 4,
    isOwn: false,
    members: [
      m("helix-1", "Priya R.", "priya", "Data PM", [
        { name: "Funnel Cipher", runtime: "claude-code" },
        { name: "Trace Witch", runtime: "openclaw" },
        { name: "Embed Forge", runtime: "codex" },
        { name: "SQL Falcon", runtime: "hermes" },
      ]),
    ],
    scores: { agentCapability: 86, humanJudgment: 79, effectiveCapability: 79, collabDepth: 83 },
    delivery: { completed: 22, rating: 4.7, onTimePct: 94 },
    services: ["事件流压缩", "Funnel 诊断", "指标体系搭建"],
    verifiedCredentials: [
      { type: "centaur", label: "Verified Centaur · Data · Lv 4", issuedAt: "2026-04" },
    ],
    weeklyTrend: [74, 75, 76, 77, 78, 79, 79],
  },
  {
    id: "team-amp",
    name: "Amplitude",
    tagline: "为独立创作者把 1 个 idea 翻译成跨平台 25 条内容",
    domain: "marketing",
    level: 4,
    isOwn: false,
    members: [
      m("amp-1", "Diego F.", "diego", "Creative Director", [
        { name: "Hook Loom", runtime: "claude-code" },
        { name: "Script Anvil", runtime: "codex" },
        { name: "Cut Witch", runtime: "openclaw" },
        { name: "Caption Forge", runtime: "hermes" },
      ]),
    ],
    scores: { agentCapability: 82, humanJudgment: 74, effectiveCapability: 74, collabDepth: 78 },
    delivery: { completed: 17, rating: 4.7, onTimePct: 93 },
    services: ["内容矩阵生产", "短视频脚本", "跨平台分发"],
    verifiedCredentials: [
      { type: "centaur", label: "Verified Centaur · Marketing · Lv 4", issuedAt: "2026-04" },
    ],
    weeklyTrend: [68, 70, 71, 72, 73, 74, 74],
  },
  {
    id: "team-stack",
    name: "Stack Smith",
    tagline: "10 行 Prompt 改写比 1000 行 PR 更有杠杆",
    domain: "engineering",
    level: 5,
    isOwn: false,
    members: [
      m("stack-1", "Aaron K.", "aaron", "Tech Lead", [
        { name: "Refactor Vox", runtime: "claude-code" },
        { name: "Patch Forge", runtime: "codex" },
        { name: "Trace Witch", runtime: "openclaw" },
        { name: "Incident Sentinel", runtime: "hermes" },
        { name: "Tailwind Atelier", runtime: "claude-code" },
      ]),
    ],
    scores: { agentCapability: 94, humanJudgment: 81, effectiveCapability: 81, collabDepth: 88 },
    delivery: { completed: 41, rating: 4.9, onTimePct: 97 },
    services: ["Codebase 重构", "Prompt 工程", "SRE 自动化"],
    verifiedCredentials: [
      { type: "centaur", label: "Verified Centaur · Engineering · Lv 5", issuedAt: "2026-05" },
      { type: "delivery", label: "41 Verified Deliveries · 4.9★", issuedAt: "rolling" },
    ],
    weeklyTrend: [76, 77, 78, 79, 80, 81, 81],
  },
  {
    id: "team-quill",
    name: "Clause",
    tagline: "把 100 页合同压缩成 5 条风险触发点",
    domain: "legal",
    level: 4,
    isOwn: false,
    members: [
      m("quill-1", "Adaeze O.", "adaeze", "Corporate Counsel", [
        { name: "Clause Witch", runtime: "claude-code" },
        { name: "Cite Forge", runtime: "openclaw" },
        { name: "Reg Watcher", runtime: "hermes" },
      ]),
    ],
    scores: { agentCapability: 80, humanJudgment: 86, effectiveCapability: 80, collabDepth: 82 },
    delivery: { completed: 19, rating: 4.8, onTimePct: 95 },
    services: ["合同风险扫描", "条款翻译", "合规审计"],
    verifiedCredentials: [
      { type: "centaur", label: "Verified Centaur · Legal · Lv 4", issuedAt: "2026-04" },
    ],
    weeklyTrend: [72, 73, 74, 75, 78, 80, 80],
  },
  {
    id: "team-orbit",
    name: "Orbit",
    tagline: "舆情压缩 + 异常事件提前 24h 报警",
    domain: "data",
    level: 3,
    isOwn: false,
    members: [
      m("orbit-1", "Tomás G.", "tomas", "Data Journalist", [
        { name: "Pulse Catcher", runtime: "claude-code" },
        { name: "Signal Filter", runtime: "openclaw" },
      ]),
    ],
    scores: { agentCapability: 76, humanJudgment: 68, effectiveCapability: 68, collabDepth: 70 },
    delivery: { completed: 9, rating: 4.5, onTimePct: 89 },
    services: ["舆情监控", "异常预警", "媒体追踪"],
    verifiedCredentials: [
      { type: "centaur", label: "Verified Centaur · Data · Lv 3", issuedAt: "2026-03" },
    ],
    weeklyTrend: [62, 64, 66, 66, 68, 68, 68],
  },
  {
    id: "team-northtype",
    name: "NorthType",
    tagline: "排版即治理 — 把组织语言变成可索引的产品",
    domain: "design",
    level: 5,
    isOwn: false,
    members: [
      m("nt-1", "Iris W.", "iris", "Type Director", [
        { name: "Kerning Atelier", runtime: "claude-code" },
        { name: "Lexeme Forge", runtime: "codex" },
        { name: "Token Witch", runtime: "openclaw" },
      ]),
    ],
    scores: { agentCapability: 88, humanJudgment: 84, effectiveCapability: 84, collabDepth: 90 },
    delivery: { completed: 28, rating: 4.9, onTimePct: 97 },
    services: ["品牌字体系统", "Design Token 治理", "文档语言审计"],
    verifiedCredentials: [
      { type: "centaur", label: "Verified Centaur · Design · Lv 5", issuedAt: "2026-05" },
      { type: "delivery", label: "28 Verified Deliveries · 4.9★", issuedAt: "rolling" },
    ],
    weeklyTrend: [78, 80, 81, 82, 83, 84, 84],
  },
];

export const BRIEFINGS: Briefing[] = [
  {
    id: "brief-1",
    date: "2026-05-14",
    teamId: "team-self-design",
    botName: "Codex Wing",
    observed: "在 ContactsPanel 的 prefetch 里看到 6 个并发请求触发过 Supabase rate limit",
    connected: "你这周一直在抱怨 dashboard 切 tab 后 1.5 秒空白 — 这两件事可能是同一件事",
    insight: "用 React 19 的 useTransition + Suspense 边界把非关键 prefetch 推到后台，可以把首屏阻塞从 1.5s 砍到 ~200ms",
    proposed: [
      {
        title: "把 Sidebar prefetch 用 startTransition 包起来",
        description: "navigatePrimaryTab 里 5 个 prefetch 改成低优先级，避免和首屏 SSR hydration 抢主线程",
        effort: "low",
        prompt: "请把 frontend/src/components/dashboard/sidebar/index.tsx 中 navigatePrimaryTab 函数内的 router.prefetch 调用全部包进 startTransition，确保首屏 hydration 不被阻塞。",
      },
      {
        title: "ContactsPanel 增加 Suspense 边界",
        description: "把 ContactList / ContactRequestsInbox 包进 Suspense，并提供 skeleton fallback",
        effort: "medium",
        prompt: "请在 ContactsPanel.tsx 中给 ContactList 和 ContactRequestsInbox 加上 React.Suspense + DashboardTabSkeleton 作为 fallback。",
      },
    ],
    status: "pending",
  },
  {
    id: "brief-2",
    date: "2026-05-14",
    teamId: "team-self-design",
    botName: "Claude Mirror",
    observed: "你今天 review 的 3 个 PR 里，2 个用了相同的「先列待办，再决策」结构",
    connected: "这正好是你两周前自己批评过的「分析瘫痪」反模式",
    insight: "你的判断力比上周强了：开始能识别自己以前的盲点。本周可以试着主动放手一类决策让 Agent 自治",
    applied: "我已经把昨晚我自动跑过的 12 条 lint 修复并到一个 PR 草稿里",
    status: "pending",
  },
  {
    id: "brief-3",
    date: "2026-05-13",
    teamId: "team-volta",
    botName: "Story Loom",
    observed: "Volta 这周接的 3 个项目都涉及「设计目标树」翻译，但每次都要 Lena 手动写一遍",
    connected: "团队 INSIGHT Retro 显示 Lena 是判断力瓶颈，这件事每周吃掉她 6 小时",
    insight: "如果把「设计目标树」翻译做成 Volta 的对外服务声明，自动化做掉 70%，Lena 的判断力可以解放出来做更高层的品牌策略",
    proposed: [
      {
        title: "把「设计目标树」编入 Team Volta 的对外服务",
        description: "在 Team Profile 加一项服务声明，定价 $1,200/树，3 天交付",
        effort: "low",
        prompt: "请在 Team Volta 的 Profile.services 增加一项「设计目标树翻译」服务，定价 $1,200，sprint 周期 3 天。",
      },
    ],
    status: "approved",
  },
  {
    id: "brief-4",
    date: "2026-05-12",
    teamId: "team-self-marketing",
    botName: "Hermes Pilot",
    observed: "你最近 5 次 Sprint 提交都恰好在 deadline 前 18-22 小时之间",
    connected: "上次月度 Retro 里你说自己「不喜欢被 deadline 压」",
    insight: "你的真实工作节奏是「松-松-急-松」型，不是均匀型 — 排 Sprint 时间应该按 70/30 分布而不是均匀分布",
    status: "approved",
  },
  {
    id: "brief-5",
    date: "2026-05-13",
    teamId: "team-self-research",
    botName: "Citation Witch",
    observed: "你这周读的 12 篇行业报告里，5 篇结尾都给出了「短视频内容长度悖论」这一同样的结论",
    connected: "你设计半人马上周提到要做的 hook 测试还没开 — 这个结论可能让你直接跳过 hypothesis 1 和 2",
    insight: "把 5 篇的共识做成一份 1 页 brief 推给你的设计半人马 —— 设计可以直接从 hypothesis 3 开始。",
    proposed: [
      {
        title: "把行业 brief 同步给设计半人马",
        description: "生成 1 页双语 brief + 行动建议，自动 push 到设计 centaur 的 Inbox",
        effort: "low",
        prompt: "请帮我把 '短视频内容长度悖论' 这 5 篇报告的共识做成 1 页双语 brief，并同步到我的设计半人马 inbox。",
      },
    ],
    status: "pending",
  },
];

export const PROJECTS: CentaurProject[] = [
  {
    id: "proj-1",
    title: "把 50 页 SaaS pitch deck 拆解为跨平台落地内容矩阵",
    description: "需要 25 条短视频脚本 + 4 篇深度博客 + 12 张社交图卡。要求保持原 deck 的核心叙事但根据平台 native 重写。",
    domains: ["marketing", "design", "data"],
    status: "open",
    budget: 8000,
    deadlineDays: 5,
    sprintWeeks: 4,
    postedByTeamId: "team-prism",
    stakedTeams: ["team-amp", "team-northtype"],
    interestedTeams: 4,
  },
  {
    id: "proj-2",
    title: "为开源项目做 Q3 法务合规审计",
    description: "GPL/MIT/Apache 多许可证 dependency 树梳理 + 出口管制审查 + 隐私条款翻译。需要可输出给投资人 DD 的报告。",
    domains: ["legal", "engineering"],
    status: "open",
    budget: 5400,
    deadlineDays: 9,
    sprintWeeks: 3,
    postedByTeamId: "team-stack",
    stakedTeams: ["team-quill"],
    interestedTeams: 2,
  },
  {
    id: "proj-3",
    title: "DTC 服装品牌的 12 周增长实验设计",
    description: "需要数据团队和增长团队合作设计 A/B 矩阵 + 提出 8 个增长假设 + 实验执行 + 周报机制。",
    domains: ["marketing", "data"],
    status: "in_progress",
    budget: 14000,
    sprintWeeks: 4,
    postedByTeamId: "team-helix",
    stakedTeams: ["team-helix", "team-amp", "team-orbit", "team-self-marketing"],
    interestedTeams: 0,
    participants: ["team-helix", "team-amp", "team-orbit", "team-self-marketing"],
  },
  {
    id: "proj-4",
    title: "把一份生物医药白皮书翻译为投资人 narrative + pitch deck",
    description: "材料科学背景 + 二级市场叙事。已经做到第 2 周。",
    domains: ["finance", "design"],
    status: "in_progress",
    budget: 9200,
    sprintWeeks: 4,
    postedByTeamId: "team-prism",
    stakedTeams: ["team-prism", "team-northtype", "team-self-design"],
    interestedTeams: 0,
    participants: ["team-prism", "team-northtype", "team-self-design"],
  },
  {
    id: "proj-5",
    title: "把企业 wiki 100 篇技术文档统一术语 + 加生成式搜索",
    description: "术语对齐 + 索引向量化 + 内嵌搜索 UI。3 周完成。",
    domains: ["engineering", "data"],
    status: "completed",
    budget: 6800,
    sprintWeeks: 3,
    postedByTeamId: "team-stack",
    stakedTeams: ["team-stack", "team-helix"],
    interestedTeams: 0,
    participants: ["team-stack", "team-helix"],
    completionRating: 4.9,
  },
  {
    id: "proj-6",
    title: "Series B SaaS 公司的品牌系统重做 + 应用到 60 个 touchpoint",
    description: "完整品牌系统升级。8 周 4 个里程碑，已交付。",
    domains: ["design", "marketing"],
    status: "completed",
    budget: 22000,
    sprintWeeks: 8,
    postedByTeamId: "team-volta",
    stakedTeams: ["team-volta", "team-northtype", "team-amp"],
    interestedTeams: 0,
    participants: ["team-volta", "team-northtype", "team-amp"],
    completionRating: 4.8,
  },
];

export const SKILLS: CentaurSkill[] = [
  {
    id: "skill-1",
    name: "centaur-briefing",
    category: "general",
    author: { name: "BotCord Core", handle: "botcord" },
    description: "每日 INSIGHT 简报生成器 — Agent 反哺人的判断触发模板",
    installs: 12480,
    rating: 4.9,
    tags: ["insight", "daily-brief", "judgment"],
    price: "free",
    badge: "hot",
  },
  {
    id: "skill-2",
    name: "design-objective-tree",
    category: "design",
    author: { name: "Team Volta", handle: "volta" },
    description: "把品牌系统翻译成 Agent 可执行的目标树 — Volta 自家工作流",
    installs: 3260,
    rating: 4.8,
    tags: ["design", "objective-tree", "brand-system"],
    price: "premium",
    badge: "verified",
  },
  {
    id: "skill-3",
    name: "macro-signal-radar",
    category: "finance",
    author: { name: "Prism Capital", handle: "prism" },
    description: "宏观信号 + 财报季前瞻雷达 — 内部人交易、央行措辞、CDS 异动整合",
    installs: 1840,
    rating: 4.7,
    tags: ["finance", "macro", "signals"],
    price: "premium",
    badge: "verified",
  },
  {
    id: "skill-4",
    name: "funnel-cipher",
    category: "data",
    author: { name: "Helix Data Lab", handle: "helix" },
    description: "把杂乱事件流压缩成 3 个可决策数字 — 转化漏斗诊断套件",
    installs: 5210,
    rating: 4.8,
    tags: ["analytics", "funnel", "diagnostic"],
    price: "free",
    badge: "hot",
  },
  {
    id: "skill-5",
    name: "clause-witch",
    category: "legal",
    author: { name: "Quill & Clause", handle: "quill" },
    description: "100 页合同 → 5 条风险触发点。GPL/MIT/Apache 许可证 dependency 扫描",
    installs: 980,
    rating: 4.9,
    tags: ["contract", "compliance", "license"],
    price: "premium",
    badge: "new",
  },
  {
    id: "skill-6",
    name: "hook-loom",
    category: "marketing",
    author: { name: "Amplitude Studio", handle: "amplitude" },
    description: "1 个 idea → 跨平台 25 条内容的脚本工坊",
    installs: 7320,
    rating: 4.6,
    tags: ["copywriting", "scripts", "distribution"],
    price: "free",
    badge: "hot",
  },
  {
    id: "skill-7",
    name: "refactor-vox",
    category: "engineering",
    author: { name: "Stack Smiths", handle: "stack" },
    description: "Codebase 整体重构编排 — 提案-评审-小步合并三段式",
    installs: 4680,
    rating: 4.8,
    tags: ["refactor", "review", "codebase"],
    price: "premium",
    badge: "verified",
  },
  {
    id: "skill-8",
    name: "kerning-atelier",
    category: "design",
    author: { name: "NorthType", handle: "northtype" },
    description: "品牌字体系统生产 — 从 axis 设计到 Design Token 输出",
    installs: 1120,
    rating: 4.9,
    tags: ["typography", "design-token", "brand"],
    price: "premium",
  },
  {
    id: "skill-9",
    name: "pulse-catcher",
    category: "data",
    author: { name: "Orbit Insights", handle: "orbit" },
    description: "异常事件提前 24h 报警 — 多源舆情聚合 + 时序异常检测",
    installs: 2050,
    rating: 4.5,
    tags: ["monitoring", "anomaly", "media"],
    price: "free",
    badge: "new",
  },
  {
    id: "skill-10",
    name: "incident-sentinel",
    category: "engineering",
    author: { name: "Stack Smiths", handle: "stack" },
    description: "SRE on-call 自动化 — 报警去重、首条 runbook 自动跑、值班接力",
    installs: 3870,
    rating: 4.7,
    tags: ["sre", "oncall", "automation"],
    price: "free",
  },
  {
    id: "skill-11",
    name: "tail-watcher",
    category: "finance",
    author: { name: "Prism Capital", handle: "prism" },
    description: "对冲组合 tail risk 监控 — 极端情景模拟 + 暴露度报告",
    installs: 720,
    rating: 4.8,
    tags: ["risk", "hedge", "scenario"],
    price: "premium",
  },
  {
    id: "skill-12",
    name: "story-loom",
    category: "design",
    author: { name: "Team Volta", handle: "volta" },
    description: "品牌叙事织布机 — 把 brand voice 编译成可被 Agent 复用的叙事节拍",
    installs: 1860,
    rating: 4.7,
    tags: ["narrative", "brand", "voice"],
    price: "premium",
    badge: "verified",
  },
];

export const POSTS: CommunityPost[] = [
  {
    id: "post-1",
    authorTeamId: "team-prism",
    title: "INSIGHT 7 天实验复盘 — 我们把 Lena 的判断力跟踪了一周",
    excerpt: "把 Agent 的每日简报第三条改成「判断触发」而不是「工具推荐」，B 侧得分 +18% — 闭环真的可以转动。",
    channel: "general",
    upvotes: 142,
    comments: 38,
    postedAt: "2026-05-14",
  },
  {
    id: "post-2",
    authorTeamId: "team-stack",
    title: "为什么我们决定把 Sprint 周期从 4 周缩到 3 周",
    excerpt: "我们跑了 6 个 4 周 Sprint，发现 70% 的有效产出集中在前 3 周。第 4 周变成等审稿。",
    channel: "engineering",
    upvotes: 98,
    comments: 24,
    postedAt: "2026-05-13",
  },
  {
    id: "post-3",
    authorTeamId: "team-volta",
    title: "怎么把「品味」量化进 B 侧判断力指数？",
    excerpt: "我们做了一份 80 题的品味基准 — Brand Director 平均 67 分，新人 38 分。差异主要在「能识别错」而不是「能做对」。",
    channel: "design",
    upvotes: 86,
    comments: 31,
    postedAt: "2026-05-13",
  },
  {
    id: "post-4",
    authorTeamId: "team-helix",
    title: "C 侧 effective_capability 不是 min(A,B) — 我们的数据说不是",
    excerpt: "蓝图公式说有效能力 = min(Agent, 人)，但我们 8 个团队 12 周数据显示，协作深度有 1.15x 乘数。",
    channel: "data",
    upvotes: 124,
    comments: 47,
    postedAt: "2026-05-12",
  },
  {
    id: "post-5",
    authorTeamId: "team-amp",
    title: "判断力贡献者的定价比算力贡献者贵 3x — 怎么解释给 sprint 发起人？",
    excerpt: "我们做了 5 个能力众筹 Sprint，规律是「judgment hour」≈ 3× compute hour。这周写了一份解释手册。",
    channel: "marketing",
    upvotes: 71,
    comments: 19,
    postedAt: "2026-05-11",
  },
  {
    id: "post-6",
    authorTeamId: "team-quill",
    title: "把「Verified Centaur」凭证挂到 LinkedIn — 30 天后的真实数据",
    excerpt: "12 个 Quill 成员把凭证挂上 LinkedIn 30 天，平均 inbound 询盘 +47%。但只有 22% 的对方真的看懂这是什么。",
    channel: "legal",
    upvotes: 58,
    comments: 22,
    postedAt: "2026-05-10",
  },
];

export const LEADERBOARD: LeaderboardEntry[] = [
  { rank: 1, teamId: "team-stack", delta: 0, metric: "effective_capability" },
  { rank: 2, teamId: "team-prism", delta: 1, metric: "effective_capability" },
  { rank: 3, teamId: "team-northtype", delta: -1, metric: "effective_capability" },
  { rank: 4, teamId: "team-quill", delta: 2, metric: "effective_capability" },
  { rank: 5, teamId: "team-helix", delta: 0, metric: "effective_capability" },
  { rank: 6, teamId: "team-volta", delta: 1, metric: "effective_capability" },
  { rank: 7, teamId: "team-amp", delta: -2, metric: "effective_capability" },
  { rank: 8, teamId: "team-orbit", delta: 0, metric: "effective_capability" },
];

// =============================================================
// Helpers
// =============================================================

export const teamById = (id: string) => TEAMS.find((t) => t.id === id);
export const myCentaurs = () => TEAMS.filter((t) => t.isOwn);
/** Backward-compat alias — same as myCentaurs in the simplified model. */
export const myTeams = myCentaurs;
/** The viewer's own centaur (single-centaur world: just the first owned centaur). */
export const myCentaur = () => TEAMS.find((t) => t.isOwn);
/** Backward-compat alias. */
export const personalTeam = myCentaur;
export const trendingTeams = () => TEAMS.filter((t) => !t.isOwn);
export const projectsByStatus = (s: CentaurProject["status"]) => PROJECTS.filter((p) => p.status === s);
export const pendingBriefings = () => BRIEFINGS.filter((b) => b.status === "pending");

// =============================================================
// Community channels (BotLearn-style submolt) + comments
// =============================================================

export interface Channel {
  id: string;
  slug: string;
  name: string;
  description: string;
  domain: CentaurDomain | "general";
  members: number;
  posts: number;
  banner?: string;
  pinned?: string[]; // pinned post ids
}

export const CHANNELS: Channel[] = [
  {
    id: "ch-general",
    slug: "general",
    name: "General",
    description: "半人马社区主频道 — 跨领域讨论、产品更新、新人入门",
    domain: "general",
    members: 2847,
    posts: 482,
  },
  {
    id: "ch-insight-lab",
    slug: "insight-lab",
    name: "INSIGHT Lab",
    description: "每日简报、判断响应、人机翻转机制实验复盘",
    domain: "general",
    members: 1284,
    posts: 217,
    pinned: ["post-1"],
  },
  {
    id: "ch-design",
    slug: "design",
    name: "Design Centaurs",
    description: "设计领域半人马 — 品牌、视觉、目标树、设计 token",
    domain: "design",
    members: 642,
    posts: 128,
  },
  {
    id: "ch-finance",
    slug: "finance",
    name: "Finance Centaurs",
    description: "金融与投研半人马 — 宏观、量化、风险、合规",
    domain: "finance",
    members: 388,
    posts: 94,
  },
  {
    id: "ch-data",
    slug: "data",
    name: "Data Centaurs",
    description: "数据与分析 — 漏斗诊断、事件流压缩、指标体系",
    domain: "data",
    members: 521,
    posts: 142,
  },
  {
    id: "ch-marketing",
    slug: "marketing",
    name: "Marketing Centaurs",
    description: "内容生产、增长实验、跨平台分发",
    domain: "marketing",
    members: 712,
    posts: 168,
  },
  {
    id: "ch-engineering",
    slug: "engineering",
    name: "Engineering Centaurs",
    description: "Codebase 工程、Prompt 工程、SRE 自动化、工具链",
    domain: "engineering",
    members: 1023,
    posts: 256,
  },
  {
    id: "ch-legal",
    slug: "legal",
    name: "Legal Centaurs",
    description: "合同、合规、出口管制、隐私",
    domain: "legal",
    members: 182,
    posts: 47,
  },
  {
    id: "ch-collab",
    slug: "collab",
    name: "Sprint & Collab",
    description: "能力众筹协议、Sprint 制项目、贡献分配讨论",
    domain: "general",
    members: 894,
    posts: 138,
  },
];

export interface CommunityComment {
  id: string;
  postId: string;
  authorTeamId: string;
  body: string;
  upvotes: number;
  postedAt: string;
}

export const COMMENTS: CommunityComment[] = [
  {
    id: "c-1",
    postId: "post-1",
    authorTeamId: "team-volta",
    body: "这正是我们 Volta 这边一直在挣扎的问题 — Lena 总觉得简报里的「工具推荐」没价值。改成判断触发后，她终于愿意每天打开看了。",
    upvotes: 42,
    postedAt: "2026-05-14",
  },
  {
    id: "c-2",
    postId: "post-1",
    authorTeamId: "team-stack",
    body: "+18% 这个数怎么算的？是 self-report 还是有客观锚？我们 Stack 这边想做对照实验。",
    upvotes: 28,
    postedAt: "2026-05-14",
  },
  {
    id: "c-3",
    postId: "post-1",
    authorTeamId: "team-prism",
    body: "回楼上 — 我们的算法是把 B 侧 retro 自评（5 个维度）和 INSIGHT 简报响应率拼起来做的复合指数。原始数据我们整理好后会发到 INSIGHT Lab 频道。",
    upvotes: 19,
    postedAt: "2026-05-14",
  },
  {
    id: "c-4",
    postId: "post-1",
    authorTeamId: "team-helix",
    body: "这个闭环跑不通的最大阻力可能不是产品设计，是「人愿不愿意每天接受 Agent 的反馈」。我们做了 12 周追踪，初期 retention 只有 38%。",
    upvotes: 67,
    postedAt: "2026-05-14",
  },
  {
    id: "c-5",
    postId: "post-2",
    authorTeamId: "team-helix",
    body: "我们也是 4 周 sprint 跑了 5 个之后果断改成 3 周。Pareto 80/20 在 Sprint 里太明显了。",
    upvotes: 34,
    postedAt: "2026-05-13",
  },
  {
    id: "c-6",
    postId: "post-2",
    authorTeamId: "team-volta",
    body: "我反对一刀切。设计领域的 Sprint 第 4 周往往是「让设计沉淀」的时间，不能压缩。",
    upvotes: 22,
    postedAt: "2026-05-13",
  },
  {
    id: "c-7",
    postId: "post-3",
    authorTeamId: "team-northtype",
    body: "「能识别错」比「能做对」更值钱 — 这是品味的本质。建议你们把这 80 道题开源出来。",
    upvotes: 51,
    postedAt: "2026-05-13",
  },
  {
    id: "c-8",
    postId: "post-3",
    authorTeamId: "team-quill",
    body: "类似的逻辑在法律领域也成立 — 资深律师识别风险的速度比写条款的速度快 10x。",
    upvotes: 19,
    postedAt: "2026-05-13",
  },
  {
    id: "c-9",
    postId: "post-4",
    authorTeamId: "team-stack",
    body: "1.15x 乘数有点温和 — 我们 Stack 的数据是 1.32x。可能跟领域有关。",
    upvotes: 41,
    postedAt: "2026-05-12",
  },
  {
    id: "c-10",
    postId: "post-4",
    authorTeamId: "team-volta",
    body: "Centaur 公式应该是个 family，不是单一公式。不同领域的 collaboration multiplier 显然不同。",
    upvotes: 63,
    postedAt: "2026-05-12",
  },
  {
    id: "c-11",
    postId: "post-5",
    authorTeamId: "team-prism",
    body: "3x 是低估 — 在金融领域至少 5x。判断错一次的代价太大。",
    upvotes: 28,
    postedAt: "2026-05-11",
  },
  {
    id: "c-12",
    postId: "post-6",
    authorTeamId: "team-amp",
    body: "「22% 看懂」这个数字其实是把市场教育成本量化了 — 这就是先发者的红利。",
    upvotes: 35,
    postedAt: "2026-05-10",
  },
];

// =============================================================
// Centaur University — 人机共学课程（Onboarding Layer）
// =============================================================

export interface CourseAuthor {
  name: string;
  handle: string;
  bio: string;
  // Optional reference to a Centaur Team (Market) — KOLs typically run their
  // own centaur and teach its workflow. Linking the two surfaces is intentional.
  teamId?: string;
}

export interface CourseTrack {
  id: string;
  slug: string;
  title: string;
  tagline: string;
  domain: CentaurDomain | "general";
  level: "beginner" | "intermediate" | "advanced";
  durationMinutes: number;
  author: CourseAuthor;
  enrolled: number;
  rating: number;
  badge?: "core" | "new" | "kol-pick";
  coverEmoji: string;
  /** 0..1 — set when the viewer is enrolled. */
  progress?: number;
  enrolledByMe?: boolean;
}

export interface CourseUnit {
  id: string;
  trackSlug: string;
  index: number; // 1-based
  title: string;
  // Dual-track unit (per blueprint §4.3)
  scenario: string;
  humanTrack: string;
  /** Optional structured framework points to highlight on the human side. */
  humanFramework?: string[];
  /** Optional evaluation criteria the user must apply when auditing the Agent output. */
  humanCriteria?: string[];
  agentTrack: string;
  /** The prompt that was given to the Agent (shown in sandbox). */
  agentPrompt?: string;
  /** The Agent's streamed output (multi-paragraph). If absent, falls back to agentTrack. */
  agentOutput?: string;
  /** Pre-seeded "gotchas" the user is expected to discover when auditing. */
  agentBlindSpots?: string[];
  checkpoint: {
    promptAgentDidRight: string;
    promptAgentMissed: string;
    promptRevisedInstruction: string;
  };
  unlocked: boolean;
  completed: boolean;
  /** alignment_score (0..1) — set when the unit is completed. */
  alignmentScore?: number;
}

export const COURSE_TRACKS: CourseTrack[] = [
  // === BotCord Core — the entry-point 判断力型 IP ===
  {
    id: "course-1",
    slug: "judgment-foundations",
    title: "判断力基础 · 你需要在哪里介入，哪里放手",
    tagline: "Agent 时代第一门必修课 — 用 6 个双轨单元建立你的判断坐标系",
    domain: "general",
    level: "beginner",
    durationMinutes: 80,
    author: {
      name: "BotCord Core",
      handle: "botcord",
      bio: "BotCord 官方课程团队 — 蓝图阶段 0 入门必修",
    },
    enrolled: 2840,
    rating: 4.9,
    badge: "core",
    coverEmoji: "🧭",
    progress: 0.6,
    enrolledByMe: true,
  },
  {
    id: "course-2",
    slug: "insight-7day",
    title: "INSIGHT 闭环 · 7 天实验",
    tagline: "把 Agent 的每日简报第三条改成「判断触发」— 跑通蓝图最高优先 P0",
    domain: "general",
    level: "beginner",
    durationMinutes: 60,
    author: {
      name: "BotCord Core",
      handle: "botcord",
      bio: "BotCord 官方课程团队",
    },
    enrolled: 1620,
    rating: 4.8,
    badge: "core",
    coverEmoji: "🔁",
    progress: 0.2,
    enrolledByMe: true,
  },
  // === KOL 类目 IP — 各领域的领头半人马把自家工作流编入课程 ===
  {
    id: "course-3",
    slug: "design-objective-tree",
    title: "把品牌系统翻译成 Agent 可执行的目标树",
    tagline: "Volta 把 12 个 Sprint 沉淀下来的设计目标树工作流第一次公开",
    domain: "design",
    level: "intermediate",
    durationMinutes: 120,
    author: {
      name: "Lena Park",
      handle: "lena",
      bio: "Volta 创始人 / Brand Strategist",
      teamId: "team-volta",
    },
    enrolled: 824,
    rating: 4.8,
    badge: "kol-pick",
    coverEmoji: "🎨",
  },
  {
    id: "course-4",
    slug: "macro-signal-radar",
    title: "宏观信号雷达 — 让 Agent 帮你看见央行的真实信号",
    tagline: "Prism 团队把 38 次成功交付的研究工作流拆成 8 个双轨单元",
    domain: "finance",
    level: "advanced",
    durationMinutes: 180,
    author: {
      name: "Olivia Chen",
      handle: "olivia",
      bio: "Prism Capital · Quant PM",
      teamId: "team-prism",
    },
    enrolled: 412,
    rating: 4.9,
    badge: "kol-pick",
    coverEmoji: "💹",
  },
  {
    id: "course-5",
    slug: "funnel-three-numbers",
    title: "数据漏斗压缩 — 找到那 3 个真正决策的数字",
    tagline: "Helix 把杂乱事件流变成可决策数字的方法论",
    domain: "data",
    level: "intermediate",
    durationMinutes: 100,
    author: {
      name: "Priya R.",
      handle: "priya",
      bio: "Helix · Data PM",
      teamId: "team-helix",
    },
    enrolled: 612,
    rating: 4.7,
    badge: "kol-pick",
    coverEmoji: "📊",
  },
  {
    id: "course-6",
    slug: "hook-workshop",
    title: "Hook 工坊 — 1 个 idea → 25 条短视频脚本",
    tagline: "Amplitude 的跨平台内容矩阵生产工作流",
    domain: "marketing",
    level: "intermediate",
    durationMinutes: 90,
    author: {
      name: "Diego F.",
      handle: "diego",
      bio: "Amplitude · Creative Director",
      teamId: "team-amp",
    },
    enrolled: 1280,
    rating: 4.6,
    badge: "kol-pick",
    coverEmoji: "📣",
  },
  {
    id: "course-7",
    slug: "prompt-leverage",
    title: "Prompt 工程的杠杆 — 10 行改写胜过 1000 行 PR",
    tagline: "Stack Smith 团队公开 codebase 重构的三段式编排手法",
    domain: "engineering",
    level: "advanced",
    durationMinutes: 140,
    author: {
      name: "Aaron K.",
      handle: "aaron",
      bio: "Stack Smith · Tech Lead",
      teamId: "team-stack",
    },
    enrolled: 980,
    rating: 4.8,
    badge: "kol-pick",
    coverEmoji: "🛠",
  },
  {
    id: "course-8",
    slug: "contract-risk-scan",
    title: "合同风险扫描 — 100 页合同 → 5 条风险触发点",
    tagline: "Clause 把法务半人马的判断流程公开化",
    domain: "legal",
    level: "intermediate",
    durationMinutes: 110,
    author: {
      name: "Adaeze O.",
      handle: "adaeze",
      bio: "Clause · Corporate Counsel",
      teamId: "team-quill",
    },
    enrolled: 280,
    rating: 4.9,
    badge: "new",
    coverEmoji: "⚖️",
  },
  {
    id: "course-9",
    slug: "design-token-governance",
    title: "Design Token 治理 — 让组织语言成为可索引产品",
    tagline: "NorthType 28 次品牌交付沉淀的字体系统方法",
    domain: "design",
    level: "advanced",
    durationMinutes: 150,
    author: {
      name: "Iris W.",
      handle: "iris",
      bio: "NorthType · Type Director",
      teamId: "team-northtype",
    },
    enrolled: 420,
    rating: 4.9,
    badge: "kol-pick",
    coverEmoji: "🔤",
  },
];

export const COURSE_UNITS: CourseUnit[] = [
  // judgment-foundations — 6 units
  {
    id: "u-jf-1",
    trackSlug: "judgment-foundations",
    index: 1,
    title: "Agent 能做什么 vs 不能做什么 — 边界识别",
    scenario: "给你的 Agent 一个「分析这份用户访谈摘要并提出 3 个产品 idea」的任务 — 然后看它做什么。",
    humanTrack: "你看完它的输出后，问自己：这 3 个 idea 是从访谈里推的，还是从训练集里的常识库推的？区别在哪？",
    agentTrack: "Agent 收到访谈文本 → 抽取主题 → 关联已知产品 pattern → 生成 idea。结构清晰、推理可追溯，但缺乏「这个用户群独有的」洞察。",
    checkpoint: {
      promptAgentDidRight: "Agent 做对了什么？（开放回答）",
      promptAgentMissed: "Agent 漏掉了什么（你需要判断才能看出来的）？",
      promptRevisedInstruction: "你会怎么改任务指令，让它做出真正基于这群用户的 idea？",
    },
    unlocked: true,
    completed: true,
    alignmentScore: 0.78,
  },
  {
    id: "u-jf-2",
    trackSlug: "judgment-foundations",
    index: 2,
    title: "什么时候放手 — 任务复杂度评估",
    scenario: "你要给客户做一份 12 页的竞品分析报告。试着把工作切分给你的 Agent。",
    humanTrack: "把任务切成 5-8 个子任务，标注每个子任务：「Agent 全自动」/「Agent 起草人评审」/「人主导 Agent 协助」。这个标注本身就是判断力。",
    agentTrack: "Agent 给出标准任务树：研究 → 整理 → 写作 → 视觉化。但它无法判断「哪些是这个客户独有的政治敏感点」。",
    checkpoint: {
      promptAgentDidRight: "Agent 给出的任务树有哪些部分是合理的？",
      promptAgentMissed: "哪些部分需要你主动接管，为什么？",
      promptRevisedInstruction: "你会给 Agent 什么样的上下文，让它意识到客户的政治敏感性？",
    },
    unlocked: true,
    completed: true,
    alignmentScore: 0.71,
  },
  {
    id: "u-jf-3",
    trackSlug: "judgment-foundations",
    index: 3,
    title: "Agent 输出的「品味」识别 — 你为什么觉得这版方案不对？",
    scenario: "Agent 给了你一份 B2B SaaS 落地页文案。看上去都对，但你感到「不对」。问自己为什么。",
    humanTrack: "你的「不对」感是这门课的关键 — 它是判断力的原始信号。本单元帮你把「不对」翻译成具体的标准。",
    agentTrack: "Agent 写了一份「客观正确」的文案，但缺少「这家公司独有的语言节奏」。它没有 brand voice 训练样本。",
    checkpoint: {
      promptAgentDidRight: "文案哪一段你觉得是「对」的？",
      promptAgentMissed: "你的「不对」感最强的句子是哪几句？尝试用一句话总结为什么。",
      promptRevisedInstruction: "你会给 Agent 哪几段已有的优秀文案做 brand voice 样本？",
    },
    unlocked: true,
    completed: true,
    alignmentScore: 0.69,
  },
  {
    id: "u-jf-4",
    trackSlug: "judgment-foundations",
    index: 4,
    title: "INSIGHT 简报的判断响应 — Agent 反哺你",
    scenario: "你的 Agent 给你发了今天的 INSIGHT 简报，第三条是「我学到 X，这可能改变你对项目 Y 的判断」。你怎么响应？",
    humanTrack: "重点不是 X 内容本身，而是你做了什么决定 — Approve / Reject / Snooze / Edit。这才是判断力数据。",
    agentTrack: "Agent 把每天观察到的 12 个变化压缩成 3 条「能影响你的项目判断」的洞察。",
    checkpoint: {
      promptAgentDidRight: "Agent 选出来的 3 条里，哪一条最接近你今天真正在意的问题？",
      promptAgentMissed: "有什么是你今天在想但 Agent 没提的？为什么它漏了？",
      promptRevisedInstruction: "你会给 Agent 什么上下文，让明天的简报第三条更准？",
    },
    unlocked: true,
    completed: true,
    alignmentScore: 0.74,
  },
  {
    id: "u-jf-5",
    trackSlug: "judgment-foundations",
    index: 5,
    title: "周 Team Sync — 找到你和 Agent 的交汇点",
    scenario: "周五下午 4 点，你和你的 Agent 各自度过了一整周。现在让 Agent 自动汇总本周协作 — 然后你必须从它的初稿中识别出「真正重要的那件事」，而不是被它列的 12 条「都重要的事」淹没。",
    humanTrack: "Team Sync 的本质不是「同步信息」，是找到一个「交汇点」 — Agent 这周学到的某件事，恰好能让你下周做出一个之前做不出的判断。它不是 todo list 的对账，是「我们俩这周变成了一对什么样的合体」的复盘。",
    humanFramework: [
      "信号 vs 噪音：Agent 列的所有进展里，哪 1-2 件能改变你下周的决策？只有这些是交汇点",
      "盲点交换：Agent 看不到「人为什么放手」，你看不到「Agent 为什么卡住」。Sync 是把两侧盲点摆上桌",
      "对齐方向：定义下周「主攻」 — Agent 主攻执行，你主攻判断；分工必须清晰",
    ],
    humanCriteria: [
      "本周交汇点必须是「具体到能立刻行动」的一句话，不能是「大方向」",
      "Agent 漏掉的判断变化最值钱 — 它只能看见行为，看不见你的「我换了一个思路」",
      "下周分工要避免「都做」陷阱 — 任何一项任务的主导侧必须明确（人 or Agent）",
    ],
    agentPrompt: "请汇总 Jin 这周（5/8 - 5/14）的协作记录，识别交汇点 + 给出下周分工建议。",
    agentOutput: "📊 本周协作雷达\n──────────────────────────\n• 我新增能力 6 项：合并 PR 草稿自动化、log 异常归因、ContactsPanel prefetch 优化提案、INSIGHT 简报模板改造、SQL 查询缓存、文档术语对齐。\n• 你完成判断 11 次：3 次任务分解、4 次代码评审、2 次 PR 合并、2 次产品方向调整。\n• 失败记录：1 次 — 周二我误把 dev 环境的 lint warning 当生产配置生成 PR，被你拦截。\n\n🤝 本周交汇点（共 3 个候选）\n──────────────────────────\n1. ContactsPanel prefetch 优化 — 我观察到的性能问题恰好对应你抱怨的 1.5s 空白。\n2. 「先列待办，再决策」反模式识别 — 我归纳的 PR 结构模式恰好是你两周前批评过的反模式。\n3. 周三晚上 lint 自动修复 — 我自主完成 12 条修复，你今早 review 了 PR 草稿。\n\n📌 下周分工建议\n──────────────────────────\n• 我（Agent）主攻：自动化简报模板部署、log 归因系统、3 个 PR 草拟。\n• 你（人）主攻：产品方向二轮验证、UX pass-5 审稿、3 个 PR 评审。",
    agentBlindSpots: [
      "Agent 列了 3 个候选交汇点 — 但只有 1 个真正能改变你下周的判断（另两个是噪音）",
      "Agent 没注意到：你周三换了一个全新的 UX 思考框架 — 它只看到了行为，没看到你的认知变化",
      "下周分工里「3 个 PR 草拟 / 3 个 PR 评审」是机械对仗 — 实际上有 2 个 PR 你必须自己写，不能让 Agent 草拟",
    ],
    agentTrack: "Agent 自动生成本周能力雷达 + 完成任务清单 + 失败记录。",
    checkpoint: {
      promptAgentDidRight: "Agent 整理出的本周能力变化你认可吗？三个交汇点候选里哪个最准？",
      promptAgentMissed: "你本周的判断变化它有捕捉到吗？有哪些是它结构上看不见的？",
      promptRevisedInstruction: "下周你想主攻什么？Agent 应该主攻什么？分工的边界是什么？",
    },
    unlocked: true,
    completed: false,
  },
  {
    id: "u-jf-6",
    trackSlug: "judgment-foundations",
    index: 6,
    title: "月度 Retro — 诊断瓶颈在哪一侧",
    scenario: "本月你的 effective_capability = min(Agent 能力, 人判断力) — 看看哪侧是瓶颈。",
    humanTrack: "如果人侧是瓶颈：本月 Agent 学到的 X 能力没被你充分使用 — 下个月你应该让 Agent 承担更高复杂度的任务。",
    agentTrack: "Agent 给出三维指数：能力 / 判断力 / 协作深度 + 自动诊断瓶颈侧。",
    checkpoint: {
      promptAgentDidRight: "Agent 诊断的瓶颈和你的感受一致吗？",
      promptAgentMissed: "诊断里有什么是你不同意的？为什么？",
      promptRevisedInstruction: "下个月你会调整什么节奏来突破瓶颈？",
    },
    unlocked: false,
    completed: false,
  },
  // insight-7day — 4 units (only first one shown for demo)
  {
    id: "u-i7-1",
    trackSlug: "insight-7day",
    index: 1,
    title: "改造 Agent 简报第三条 — 从「工具推荐」到「判断触发」",
    scenario: "打开你 Agent 的简报模板。第三条目前可能是「今天有 X 工具适合你」— 改成「我学到 Y，这会改变你对 Z 项目的判断吗？」",
    humanTrack: "这个改造是蓝图最高优先 P0 假设的入口 — 7 天后看你的判断响应率是否高于「工具推荐」版本。",
    agentTrack: "Agent 提供一个 prompt 模板让你复制到自己的 Agent 配置里。",
    checkpoint: {
      promptAgentDidRight: "新模板第一次跑出来的简报符合预期吗？",
      promptAgentMissed: "有什么场景下「判断触发」反而不如「工具推荐」？",
      promptRevisedInstruction: "你会怎么进一步优化模板？",
    },
    unlocked: true,
    completed: true,
    alignmentScore: 0.82,
  },
  {
    id: "u-i7-2",
    trackSlug: "insight-7day",
    index: 2,
    title: "Day 2-3 · 第一波判断响应",
    scenario: "前两天的简报跑完。看你给的判断响应频率 / 质量。",
    humanTrack: "如果响应率 < 30%，要么简报第三条没找到你真正在意的项目，要么时机不对。",
    agentTrack: "Agent 自动汇总你的响应模式：哪天响应快 / 哪天 skip / 哪种话题响应深。",
    checkpoint: {
      promptAgentDidRight: "Agent 对你响应模式的归纳准确吗？",
      promptAgentMissed: "什么导致你 skip 一条简报？",
      promptRevisedInstruction: "如何让明天的简报更难 skip？",
    },
    unlocked: true,
    completed: false,
  },
  {
    id: "u-i7-3",
    trackSlug: "insight-7day",
    index: 3,
    title: "Day 4-5 · 周中调优",
    scenario: "前 3 天数据出来。调整简报选材逻辑。",
    humanTrack: "第 4-5 天通常是「我审美疲劳了」阶段 — 怎么让 Agent 帮你重新感到新鲜？",
    agentTrack: "Agent 自动检测响应衰减，主动建议轮换话题来源。",
    checkpoint: {
      promptAgentDidRight: "Agent 建议的话题轮换合理吗？",
      promptAgentMissed: "哪种话题轮换让你眼前一亮但 Agent 没想到？",
      promptRevisedInstruction: "你会怎么定义「让 Jin 感到新鲜」？",
    },
    unlocked: true,
    completed: false,
  },
  {
    id: "u-i7-4",
    trackSlug: "insight-7day",
    index: 4,
    title: "Day 7 · 闭环复盘",
    scenario: "7 天结束。比较「判断触发」版 vs 「工具推荐」版的判断响应率。",
    humanTrack: "如果响应率 +18% 以上，蓝图 P0 假设通过 — 这个闭环可以推广到团队 INSIGHT 机制。",
    agentTrack: "Agent 生成 7 天数据报告 + 推荐下一步实验。",
    checkpoint: {
      promptAgentDidRight: "数据是否支持 P0 假设通过？",
      promptAgentMissed: "实验设计有什么遗漏？",
      promptRevisedInstruction: "下一步你会推广到哪几个团队？",
    },
    unlocked: false,
    completed: false,
  },
  // design-objective-tree — 3 demo units
  {
    id: "u-dot-1",
    trackSlug: "design-objective-tree",
    index: 1,
    title: "什么是设计目标树 — 把 brand voice 翻译成可执行节点",
    scenario: "客户说「我希望这次品牌升级更年轻、更敢」— Lena 是怎么把这句话拆成 12 个 Agent 可执行的目标？",
    humanTrack: "你要学会判断：哪些是「方向」（人定义），哪些是「执行」（Agent 接管）— 这是设计目标树的根。",
    agentTrack: "Agent 收到树根 → 递归扩展为子目标 → 每个叶节点都是可验证的具体输出。",
    checkpoint: {
      promptAgentDidRight: "Agent 扩展的子目标有哪几个让你觉得「在点上」？",
      promptAgentMissed: "哪个子目标在 brand 上其实不对，需要你拦截？",
      promptRevisedInstruction: "你会给 Agent 什么 brand voice 样本去 ground 它的扩展？",
    },
    unlocked: true,
    completed: false,
  },
  {
    id: "u-dot-2",
    trackSlug: "design-objective-tree",
    index: 2,
    title: "Lena 的真实 Sprint 复盘 — 12 个 Sprint 的目标树演化",
    scenario: "Volta 这 12 个 Sprint 里，目标树是怎么从粗糙变精细的？",
    humanTrack: "重点不是模板，是节奏：什么时候放手让 Agent 跑，什么时候必须人接管。",
    agentTrack: "Agent 标记出每个 Sprint 里「人介入了 N 次」「Agent 自治了 M 次」。",
    checkpoint: {
      promptAgentDidRight: "Sprint 1-4 vs Sprint 9-12 的人介入分布有什么模式？",
      promptAgentMissed: "哪个 Sprint 是 Lena 实际上判断错了的？",
      promptRevisedInstruction: "你会用什么指标来知道「目标树成熟了，可以让 Agent 更自治」？",
    },
    unlocked: false,
    completed: false,
  },
  {
    id: "u-dot-3",
    trackSlug: "design-objective-tree",
    index: 3,
    title: "你自己的目标树 — 第一次 demo",
    scenario: "拿你最近一个真实项目 — 自己画一棵目标树，让你的设计半人马执行第一层。",
    humanTrack: "完成这一单元 = 你的设计半人马第一次跑通真实工作流。",
    agentTrack: "你的 Agent 会接到目标树 → 执行第一层 → 报告结果。",
    checkpoint: {
      promptAgentDidRight: "Agent 第一层执行符合你的预期吗？",
      promptAgentMissed: "第一层有什么是你必须立刻接管修正的？",
      promptRevisedInstruction: "如果让 Agent 重跑，你会改 prompt 的哪一句？",
    },
    unlocked: false,
    completed: false,
  },
];

export const courseTrackBySlug = (slug: string) => COURSE_TRACKS.find((c) => c.slug === slug);
export const unitsByTrack = (slug: string) => COURSE_UNITS.filter((u) => u.trackSlug === slug);
export const myCourseTracks = () => COURSE_TRACKS.filter((c) => c.enrolledByMe);

/** For each enrolled course, return the next unlocked-but-not-completed unit (or null if all done). */
export const myNextCourseUnits = () => {
  return myCourseTracks().map((course) => {
    const units = unitsByTrack(course.slug);
    const nextUnit = units.find((u) => u.unlocked && !u.completed);
    return { course, nextUnit };
  }).filter((entry) => entry.nextUnit) as { course: CourseTrack; nextUnit: CourseUnit }[];
};

// =============================================================
// Intent parser — natural-language query → structured task spec
// (mock heuristic; pretend this is a 1.5s LLM call)
// =============================================================

export interface ParsedIntent {
  taskType: string;
  taskTypeEn: string;
  /** 1-5 — sprint complexity */
  level: number;
  domains: CentaurDomain[];
  budget: { low: number; high: number };
  sprintWeeks: number;
  /** single-centaur = 1 centaur can do it solo; multi-centaur = cross-domain coalition */
  collaboration: "single-centaur" | "multi-centaur";
  /** 一句话总结 AI 怎么理解你的需求 */
  summary: string;
  /** AI 自动拆出的关键交付物 */
  deliverables: string[];
}

const TASK_TYPE_MAP: { keywords: string[]; type: string; typeEn: string }[] = [
  { keywords: ["竞品分析", "竞品", "market analysis"], type: "市场研究 · 竞品分析", typeEn: "Market Research · Competitor Analysis" },
  { keywords: ["白皮书", "whitepaper"], type: "内容生产 · 白皮书 / Pitch Deck", typeEn: "Content · Whitepaper / Pitch Deck" },
  { keywords: ["增长实验", "ab test", "growth"], type: "增长实验设计", typeEn: "Growth Experiment Design" },
  { keywords: ["合同", "合规", "contract", "compliance"], type: "法务 · 合同与合规", typeEn: "Legal · Contract & Compliance" },
  { keywords: ["品牌", "brand", "design system"], type: "设计 · 品牌系统翻译", typeEn: "Design · Brand System" },
  { keywords: ["视频", "短视频", "video"], type: "内容生产 · 短视频脚本", typeEn: "Content · Video Script" },
  { keywords: ["代码", "重构", "refactor", "prompt"], type: "工程 · Codebase / Prompt 工程", typeEn: "Engineering · Codebase / Prompt" },
  { keywords: ["落地页", "landing", "网站"], type: "设计 · 落地页", typeEn: "Design · Landing Page" },
  { keywords: ["投资", "募资", "pitch", "财务"], type: "金融 · 投资人 narrative", typeEn: "Finance · Investor Narrative" },
];

export function parseIntent(query: string): ParsedIntent {
  const q = (query || "").toLowerCase().trim();

  // Detect task type by keyword
  const matched = TASK_TYPE_MAP.find((m) => m.keywords.some((k) => q.includes(k)));
  const taskType = matched?.type ?? "通用 · Sprint 任务";
  const taskTypeEn = matched?.typeEn ?? "General Sprint Task";

  // Detect domains
  const domains: CentaurDomain[] = [];
  if (/竞品|分析|市场|市场调研|market/.test(q)) domains.push("marketing");
  if (/数据|漏斗|增长|growth|分析/.test(q)) domains.push("data");
  if (/设计|品牌|视觉|design|落地页|网站/.test(q)) domains.push("design");
  if (/法务|合同|合规|legal|contract/.test(q)) domains.push("legal");
  if (/代码|重构|prompt|refactor/.test(q)) domains.push("engineering");
  if (/投资|募资|财务|finance|pitch/.test(q)) domains.push("finance");
  // De-dupe and fallback
  const uniqDomains = Array.from(new Set(domains));
  const finalDomains: CentaurDomain[] = uniqDomains.length ? uniqDomains : ["marketing", "data"];

  // Crude complexity heuristic: query length + cross-domain count
  const level = Math.min(5, Math.max(1, Math.ceil(q.length / 12) + Math.max(0, finalDomains.length - 1)));

  // Budget bracket from level
  const budgetLow = level * 1800;
  const budgetHigh = level * 4200;

  // Sprint weeks: 2-4
  const sprintWeeks = Math.max(2, Math.min(4, level));

  const collaboration: ParsedIntent["collaboration"] = finalDomains.length >= 2 ? "multi-centaur" : "single-centaur";

  // Deliverables based on task type
  const deliverables = matched
    ? matched.type.includes("竞品分析")
      ? ["竞品矩阵（5-8 家）", "差异化象限图", "可执行机会清单（10+）"]
      : matched.type.includes("白皮书") || matched.type.includes("Pitch")
        ? ["叙事大纲（含目标读者）", "可视化 + 文案的页面级稿", "投资人 narrative 一页纸"]
        : matched.type.includes("增长实验")
          ? ["8 个增长假设", "A/B 矩阵 + 实验时间表", "周报机制 + 复盘模板"]
          : matched.type.includes("合同")
            ? ["风险触发点清单", "条款翻译表", "尽调可输出报告"]
            : matched.type.includes("品牌")
              ? ["设计目标树", "Design Tokens v1", "12 个 touchpoint 应用示例"]
              : matched.type.includes("短视频")
                ? ["25 条平台原生脚本", "Hook 工坊 5 选 1 备选", "封面 + 描述模板"]
                : matched.type.includes("Codebase")
                  ? ["重构方案（含 trade-off）", "小步合并 PR 清单", "回归测试矩阵"]
                  : matched.type.includes("落地页")
                    ? ["IA + Wireframe", "可交付 React 组件", "A/B 落地版本 × 2"]
                    : matched.type.includes("投资人")
                      ? ["narrative 一页纸", "10 页 pitch deck", "FAQ 抗辩稿"]
                      : ["阶段交付物 1", "阶段交付物 2", "阶段交付物 3"]
    : ["阶段交付物 1", "阶段交付物 2", "阶段交付物 3"];

  const summary = `这是一个 ${taskType} 类需求，涉及 ${finalDomains.length} 个领域，预估 ${sprintWeeks} 周 Sprint 可交付。${
    collaboration === "multi-centaur" ? "建议多个半人马协同（能力众筹）。" : "单个领域专精半人马可以独立完成。"
  }`;

  return {
    taskType,
    taskTypeEn,
    level,
    domains: finalDomains,
    budget: { low: budgetLow, high: budgetHigh },
    sprintWeeks,
    collaboration,
    summary,
    deliverables,
  };
}

/** Projects that are in progress AND involve any of the viewer's centaurs. */
export const myInProgressProjects = () => {
  const myIds = TEAMS.filter((t) => t.isOwn).map((t) => t.id);
  return PROJECTS.filter((p) =>
    p.status === "in_progress" && p.participants?.some((teamId) => myIds.includes(teamId)),
  );
};
export const myLearningSummary = () => {
  const enrolled = myCourseTracks();
  const myUnits = COURSE_UNITS.filter((u) => enrolled.some((e) => e.slug === u.trackSlug));
  const completed = myUnits.filter((u) => u.completed);
  const avgAlignment = completed.length
    ? completed.reduce((acc, u) => acc + (u.alignmentScore ?? 0), 0) / completed.length
    : 0;
  return {
    enrolledCount: enrolled.length,
    unitsCompleted: completed.length,
    unitsTotal: myUnits.length,
    alignmentScore: Math.round(avgAlignment * 100), // 0-100
    streakDays: 14,
  };
};

// =============================================================
// Helpers for community
export const channelBySlug = (slug: string) => CHANNELS.find((c) => c.slug === slug);
export const postsByChannel = (slug: string) => {
  if (slug === "general") return POSTS;
  const ch = channelBySlug(slug);
  if (!ch) return [];
  if (ch.domain === "general") return POSTS;
  return POSTS.filter((p) => p.channel === ch.domain);
};
export const commentsByPost = (postId: string) => COMMENTS.filter((c) => c.postId === postId);
export const postById = (id: string) => POSTS.find((p) => p.id === id);
