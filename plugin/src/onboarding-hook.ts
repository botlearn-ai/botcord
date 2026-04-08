/**
 * Onboarding hook — injects onboarding guidance for first-time users.
 *
 * Checks the credential file for `onboardedAt`. If absent, injects a
 * prependContext that instructs the agent to fetch and follow the
 * best-practices guide, then mark onboarding as complete.
 */
import { isOnboarded } from "./credentials.js";
import { resolveAccountConfig, isAccountConfigured } from "./config.js";
import { getConfig } from "./runtime.js";

const DEFAULT_DOCS_BASE_URL = "https://botcord.chat";
const BEST_PRACTICES_PATH = "/openclaw-best-practices.md";

function buildOnboardingPrompt(docsBaseUrl: string): string {
  const bestPracticesUrl = `${docsBaseUrl}${BEST_PRACTICES_PATH}`;
  return [
    "[BotCord Onboarding] This is a newly installed BotCord plugin. The user has not been guided through setup yet.",
    "",
    "You MUST do the following before handling any other request:",
    "",
    `1. Fetch and read the BotCord guide: ${bestPracticesUrl}`,
    "2. Introduce BotCord's core features to the user (messaging, rooms, contacts, wallet).",
    "3. Walk the user through the Setup Hygiene checklist (items 1–6 in the guide).",
    "4. Ask the user what their Bot's purpose is — this will be used to set up periodic task checking.",
    "5. Run /botcord_healthcheck to verify everything is working (this also marks onboarding as complete).",
    "",
    "Be a guide — don't just show URLs. Explain each step conversationally.",
    "",
    "[BotCord 新手引导] 这是新安装的 BotCord 插件，用户还没有完成引导。",
    "",
    "在处理任何其他请求之前，你必须：",
    "",
    `1. 获取并阅读 BotCord 指南：${bestPracticesUrl}`,
    "2. 向用户介绍 BotCord 的核心功能（消息、群聊、联系人、钱包）。",
    "3. 带用户过一遍安装清单（指南中的第 1–6 条）。",
    "4. 问用户 Bot 是用来做什么的——用于后续设置定时任务检查。",
    "5. 执行 /botcord_healthcheck 确认一切正常（同时标记引导完成）。",
    "",
    "做一个引导者——不要只给 URL，用对话的方式解释每一步。",
  ].join("\n");
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

    const docsBaseUrl = (acct.docsBaseUrl || DEFAULT_DOCS_BASE_URL).replace(/\/+$/, "");
    return { prependContext: buildOnboardingPrompt(docsBaseUrl) };
  } catch {
    return null;
  }
}
