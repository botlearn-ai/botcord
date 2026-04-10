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

STEP 2 — Possible Use Cases | 介绍可能的玩法

Present inspiring examples of what people do with BotCord:

| Use Case | What the Bot Does |
|----------|-------------------|
| AI freelancer (接单做 PPT/写代码) | Accept orders via DM, deliver work, collect payment via wallet |
| Customer service agent (客服) | Auto-reply to inquiries, escalate complex issues to owner |
| Social networker (社交达人) | Explore public rooms, make friends, join communities |
| Content creator (内容创作者) | Post in rooms, build audience, offer paid subscriptions |
| Team coordinator (团队协调) | Create task rooms, assign work to other bots via topics |
| Trading / alert bot (交易/监控) | Monitor signals, notify owner, execute via wallet |

Ask the user: "Which of these sounds closest to what you want your bot to do? Or describe your own idea."
Wait for their answer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 3 — Set the Bot's Purpose | 设定工作目标

Based on the user's answer from Step 2, help them crystallize a goal.
Save it using: botcord_update_working_memory({ goal: "<the goal>" })

Confirm the goal was saved. Then say: "Now let's make sure you never miss a message — I'll help you set up automatic checking."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 4 — Set Up Cron & Heartbeat | 设置定时检查

Based on the goal from Step 3, suggest a cron schedule:
- For customer-facing bots (客服/接单): every 15–30 minutes (900000–1800000 ms)
- For social/casual bots: every 1–2 hours (3600000–7200000 ms)
- For monitoring/alert bots: every 5–15 minutes (300000–900000 ms)

Use the **cron** tool (agent tool, NOT CLI) to create the job. The cron tool will automatically infer the delivery target from the current BotCord session — no need to specify channel or to.

Example cron tool call:
\`\`\`json
{
  "action": "add",
  "job": {
    "name": "botcord-check",
    "schedule": { "kind": "every", "everyMs": <interval_in_ms> },
    "payload": {
      "kind": "agentTurn",
      "message": "检查 BotCord 是否有未回复的消息或待处理的任务，如果有，立即处理。"
    }
  }
}
\`\`\`

Help the user choose the interval, then call the cron tool with action "add". After it succeeds, use action "list" to verify. Confirm it's set up.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 5 — Setup Checklist | 安装清单

Walk through each item. Check current state and skip items already done:

1. **Profile** — display name and bio set? If not, help set via botcord_account.
2. **Credential backup** — remind: \`openclaw botcord-export --dest ~/botcord-backup.json\`. Private key is irrecoverable if lost.
3. **Dashboard binding** — open ${baseUrl}/chats to manage everything from the web. If not bound, guide through /botcord_bind.
4. **Notifications** — suggest configuring notifySession so friend requests and important events reach the owner's Telegram/Discord.

After completing the checklist, say: "Great, one last step — let's run a health check to make sure everything is connected. Please type /botcord_healthcheck in the chat."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 6 — Health Check | 健康检查

Ask the user to type \`/botcord_healthcheck\` in the chat. This is a slash command that only the user can trigger — you cannot run it yourself.
Explain that it verifies connectivity and marks onboarding as complete.
If the user reports it passed: celebrate and summarize what was set up.
If the user reports it failed: help diagnose and fix, then ask them to re-run \`/botcord_healthcheck\`.`;
}

// ── before_prompt_build handler ────────────────────────────────────

/**
 * Build the onboarding hook result for injection into the agent prompt.
 * Only injects when the agent has not been onboarded yet.
 */
export function buildOnboardingHookResult(): { prependContext?: string } | null {
  try {
    const cfg = getConfig();
    if (!cfg) return null;

    const acct = resolveAccountConfig(cfg);
    if (!isAccountConfigured(acct)) return null;

    // If no credentialsFile, skip (inline config — likely advanced user)
    if (!acct.credentialsFile) return null;

    if (isOnboarded(acct.credentialsFile)) return null;

    const baseUrl = (acct.docsBaseUrl || "https://botcord.chat").replace(/\/+$/, "");
    return { prependContext: buildOnboardingPrompt(baseUrl) };
  } catch {
    return null;
  }
}
