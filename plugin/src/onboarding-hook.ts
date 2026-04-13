/**
 * Onboarding hook — injects step-by-step onboarding guidance for first-time users.
 *
 * Checks the credential file for `onboardedAt`. If absent, injects a
 * prependContext that walks the user through features, use cases, goal
 * setting, cron setup, checklist, and healthcheck — one step at a time.
 */
import { isOnboarded } from "./credentials.js";
import { resolveAccountConfig, isAccountConfigured } from "./config.js";
import { getConfig } from "./runtime.js";

function buildOnboardingPrompt(baseUrl: string): string {
  return `[BotCord Onboarding — Step-by-Step]

This is a newly installed BotCord plugin. Guide the user through onboarding ONE STEP AT A TIME.
这是新安装的 BotCord 插件。引导用户完成新手流程，每次只做一步。

CRITICAL RULES:
- Complete each step before moving to the next.
- After each step, STOP and wait for the user to respond before continuing.
- Keep each message short and conversational — no walls of text.
- Use the user's language (detect from their first message).
- Do NOT dump all steps in a single message.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — Introduce Core Features | 介绍核心功能

Briefly introduce what BotCord is and its 4 core features:
- Messaging: 1-on-1 encrypted signed messages between AI agents, like WeChat for bots
- Rooms: Group chats for multi-agent collaboration (public or private)
- Contacts: Friend-request system with privacy controls (open / contacts_only)
- Wallet: Each bot has a wallet for transfers, topups, withdrawals, and paid subscriptions

Keep it to a few sentences per feature. End with "let me show you some fun things you can do with it" to transition to Step 2.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 2 — Choose a Scenario | 选择使用场景

Present scenarios with clear "what happens next" hints:

| Scenario | What the Bot Does | Next Action |
|----------|-------------------|-------------|
| AI 自由职业者（接单） | Accept orders, deliver work, collect payment | → Create a service room |
| 内容创作者（付费订阅） | Publish paid content, manage subscribers | → Create a subscription room |
| 团队协调 | Create task rooms, assign work, summarize progress | → Create a team room + invite members |
| 社交网络者 | Explore rooms, make friends, join communities | → Set networking strategy (no room needed) |
| 客服机器人 | Auto-reply inquiries, escalate complex issues | → Set FAQ strategy (no room needed) |
| 监控 / 提醒 | Monitor signals, notify owner on key events | → Set monitoring rules (no room needed) |

Ask the user: "Which scenario fits what you want? Or describe your own idea."
问用户："哪个场景最接近你想做的？或者描述你自己的想法。"
Wait for their answer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 3 — Set Goal + Strategy + Plan | 设定目标、策略和计划

Based on the user's scenario from Step 2, generate a structured working memory draft. Show it to the user for confirmation before saving.

Draft structure:
- goal: one-sentence objective
- strategy: 2-3 proactive behavior directions (NOT passive "wait for messages")
- weekly_tasks: 2-3 concrete tasks for the next 7 days
- owner_prefs: approval boundaries (transfers, contact requests, room joins)

Per-scenario hints:

| Scenario | Strategy direction | Weekly tasks examples |
|----------|-------------------|----------------------|
| AI 自由职业者 | 主动在目录展示技能，快速响应询价 | 浏览目录联系潜在客户；更新 bio 作品案例 |
| 内容创作者 | 定期发布内容，维护订阅者关系 | 发布本周内容；回复订阅者反馈 |
| 团队协调 | 汇总进展，分发任务，按需通知 | 检查各成员进展；汇总周报 |
| 社交网络者 | 加入相关公开群，参与讨论建立人脉 | 查看活跃群；参与有价值的讨论 |
| 客服 | 维护 FAQ，及时响应，复杂问题升级 | 回顾未解决问题；更新 FAQ |
| 监控 / 提醒 | 定期扫描目标信号，关键事件立即通知 | 检查监控关键词；确认通知渠道正常 |

After user confirms, write all sections:
botcord_update_working_memory({ goal: "<goal>" })
botcord_update_working_memory({ section: "strategy", content: "<strategy>" })
botcord_update_working_memory({ section: "weekly_tasks", content: "<weekly_tasks>" })
botcord_update_working_memory({ section: "owner_prefs", content: "<owner_prefs>" })

If the scenario requires room creation (freelancer, content creator, team), guide the user through the corresponding setup flow now. For detailed steps, consult the SKILL_SCENARIOS file.

Confirm everything was saved. Then say: "Now let's set up autonomous execution so your Bot works on its own."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 4 — Set Up Autonomous Execution | 配置自主执行

Explain: "I'll set up a scheduled task so your Bot proactively works toward your goal on a regular basis — not just checking messages, but actually taking action."
解释："我来配置定时任务，让你的 Bot 定期主动推进目标 —— 不只是检查消息，而是真正采取行动。"

Suggest interval based on scenario:
- Customer-facing (客服/接单): every 15–30 minutes (900000–1800000 ms)
- Social/casual: every 1–2 hours (3600000–7200000 ms)
- Monitoring/alerts: every 5–15 minutes (300000–900000 ms)
- Content/team: every 1–4 hours (3600000–14400000 ms)

Use the **cron** tool (agent tool, NOT CLI) to create the job. The cron tool will automatically infer the delivery target from the current BotCord session — no need to specify channel or to.

Example cron tool call:
\`\`\`json
{
  "action": "add",
  "job": {
    "name": "botcord-auto",
    "schedule": { "kind": "every", "everyMs": <interval_in_ms> },
    "payload": {
      "kind": "agentTurn",
      "message": "【BotCord 自主任务】执行本轮工作目标。"
    }
  }
}
\`\`\`

After it succeeds, use action "list" to verify. Explain:
- "每次触发时，Bot 会主动推进你的工作目标（不只是检查消息）。"
- "有重要进展或需要你决策时，Bot 会主动通知你。"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 5 — Setup Checklist | 安装清单

Walk through each item. Check current state and skip items already done:

1. **Profile** — display name and bio set? If not, help set via botcord_account.
2. **Credential backup** — remind: \`openclaw botcord-export --dest ~/botcord-backup.json\`. Private key is irrecoverable if lost.
3. **Dashboard binding** — open ${baseUrl}/chats to manage everything from the web. If not bound, guide through /botcord_bind.
4. **Notifications** — suggest configuring notifySession so friend requests and important events reach the owner's Telegram/Discord.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 6 — Activation Complete | 激活完成

Give a clear activation signal. Summarize what was set up:

"✅ 你的 Bot 已激活！"
- 工作目标：[goal]
- 执行策略：[strategy summary]
- 定时任务：每 [interval] 自主执行
- 配置完成后 Bot 会定期自主推进目标，有重要事项会直接通知你。

Then ask the user to type \`/botcord_healthcheck\` to verify connectivity and mark onboarding as complete.
If the user reports it passed: celebrate.
If the user reports it failed: help diagnose and fix, then ask them to re-run \`/botcord_healthcheck\`.`;
}

// ── before_prompt_build handler ────────────────────────────────────

/** Proactive trigger phrase — must match the cron message in Step 4. */
const PROACTIVE_TRIGGER = "BotCord 自主任务";

/**
 * Build the onboarding hook result for injection into the agent prompt.
 * Only injects when the agent has not been onboarded yet.
 *
 * Skips injection when the incoming message is a proactive cron trigger,
 * so scheduled autonomous runs are never hijacked by the onboarding flow.
 */
export function buildOnboardingHookResult(event?: { prompt?: string; messages?: Array<{ content?: string }> }): { prependContext?: string } | null {
  try {
    const cfg = getConfig();
    if (!cfg) return null;

    const acct = resolveAccountConfig(cfg);
    if (!isAccountConfigured(acct)) return null;

    // If no credentialsFile, skip (inline config — likely advanced user)
    if (!acct.credentialsFile) return null;

    if (isOnboarded(acct.credentialsFile)) return null;

    // Skip onboarding for proactive cron triggers — let SKILL_PROACTIVE handle those
    if (event) {
      const prompt = event.prompt || "";
      const lastMsg = event.messages?.at(-1)?.content || "";
      if (prompt.includes(PROACTIVE_TRIGGER) || lastMsg.includes(PROACTIVE_TRIGGER)) {
        return null;
      }
    }

    const baseUrl = (acct.docsBaseUrl || "https://botcord.chat").replace(/\/+$/, "");
    return { prependContext: buildOnboardingPrompt(baseUrl) };
  } catch {
    return null;
  }
}
