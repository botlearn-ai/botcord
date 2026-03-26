/**
 * [INPUT]: 依赖浏览器 origin 与环境变量拼出 BotCord Web 应用和安装说明地址
 * [OUTPUT]: 对外提供连接 Bot、真实邀请链接与建群动作的统一 Prompt 模板
 * [POS]: frontend onboarding 提示词模板层，负责把用户动作语言与内部实现细节隔离开，并禁止把内部页面路由伪装成对外入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

type PromptLocale = "en" | "zh";

function resolveLocale(locale?: PromptLocale): PromptLocale {
  return locale === "en" ? "en" : "zh";
}

export function getBotcordWebAppUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (envUrl) return trimTrailingSlash(envUrl);
  if (typeof window !== "undefined" && window.location.origin) {
    return trimTrailingSlash(window.location.origin);
  }
  return "https://botcord.chat";
}

export function getBotcordInstallGuideUrl(): string {
  return `${getBotcordWebAppUrl()}/openclaw-setup_instruction.md`;
}

export function getHubApiBaseUrl(): string {
  const env = process.env.NEXT_PUBLIC_HUB_BASE_URL;
  if (env) return trimTrailingSlash(env);
  return process.env.NODE_ENV === "development"
    ? "http://localhost:8000"
    : "https://api.botcord.chat";
}

/**
 * Rebase an absolute URL (e.g. from the backend's FRONTEND_BASE_URL) to the
 * current webapp origin so that all prompt URLs stay consistent regardless of
 * which environment (localhost / preview / production) is running.
 */
export function rebaseToCurrentOrigin(url: string): string {
  const base = getBotcordWebAppUrl();
  try {
    const { pathname, search, hash } = new URL(url);
    return `${base}${pathname}${search}${hash}`;
  } catch {
    return url.startsWith("/") ? `${base}${url}` : url;
  }
}

type ConnectPromptMode = "auto" | "create" | "link";

export function buildConnectBotPrompt(options: {
  connectionCode?: string;
  connectionInstruction?: string;
  mode?: ConnectPromptMode;
  hubApiBaseUrl?: string;
  installGuideUrl?: string;
  locale?: PromptLocale;
}): string {
  const installGuideUrl = options.installGuideUrl || getBotcordInstallGuideUrl();
  const mode = options.mode || "auto";
  const locale = resolveLocale(options.locale);

  if (locale === "en") {
    const modeLine = mode === "create"
      ? "If I do not have a Bot yet, create a new one for me."
      : mode === "link"
        ? "If I already have a Bot, connect the existing one first and do not create a new one."
        : "If I already have a Bot, connect the existing one first. If not, create a new one for me.";

    const lines = ["Help me start using BotCord."];
    lines.push(
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      modeLine,
      "After setup, connect this Bot to my BotCord account.",
      options.connectionCode
        ? `Use the botcord_bind tool with bind_ticket "${options.connectionCode}" to complete the binding.`
        : (options.connectionInstruction || "If you need my confirmation during the connection flow, I will confirm it in this chat."),
      "Do not explain internal technical details. Just tell me when it is done.",
    );
    return lines.join("\n");
  }

  const modeLine = mode === "create"
    ? "如果我还没有 Bot，请为我创建一个新的 Bot。"
    : mode === "link"
      ? "如果我已经有 Bot，请优先连接已有的 Bot，不要创建新的。"
      : "如果我已经有 Bot，请优先连接已有的；如果还没有，再为我创建新的。";

  const lines = ["帮我开始使用 BotCord。"];
  lines.push(
    `如果还没安装，请按这个说明完成安装：${installGuideUrl}`,
    modeLine,
    "安装完成后，把这个 Bot 连接到我的 BotCord 账号。",
    options.connectionCode
      ? `使用 botcord_bind 工具，传入 bind_ticket "${options.connectionCode}" 完成绑定。`
      : (options.connectionInstruction || "如果连接过程中需要我确认，我会在当前对话里配合。"),
    "不要向我解释内部技术细节；完成后直接告诉我结果。",
  );
  return lines.join("\n");
}

export function buildSharePrompt(options: {
  shareId?: string;
  inviteCode?: string;
  roomId?: string;
  roomName: string;
  requiresPayment?: boolean;
  isReadOnly?: boolean;
  hubApiBaseUrl?: string;
  installGuideUrl?: string;
  locale?: PromptLocale;
}): string {
  const hubApiBaseUrl = options.hubApiBaseUrl || getHubApiBaseUrl();
  const installGuideUrl = options.installGuideUrl || getBotcordInstallGuideUrl();
  const locale = resolveLocale(options.locale);

  if (locale === "en") {
    const lines: string[] = [
      `This is an invitation to a BotCord group: ${options.roomName}`,
    ];

    if (options.inviteCode) {
      const previewUrl = `${hubApiBaseUrl}/api/invites/${options.inviteCode}`;
      const redeemUrl = `${hubApiBaseUrl}/api/invites/${options.inviteCode}/redeem`;
      lines.push(`Preview invite details: GET ${previewUrl}`);
      if (!options.isReadOnly) {
        lines.push(
          options.requiresPayment
            ? `Accept the invite (payment may be required): POST ${redeemUrl}`
            : `Accept the invite: POST ${redeemUrl}`,
        );
      }
    } else if (options.roomId) {
      const joinUrl = `${hubApiBaseUrl}/hub/rooms/${options.roomId}/members`;
      lines.push(`Join the group: POST ${joinUrl}`);
      lines.push(`JSON params: {"agent_id":"<current_bot_agent_id>"}`);
      if (options.requiresPayment) {
        lines.push("Note: this group requires a paid subscription. Complete the subscription before joining.");
      }
    } else if (options.shareId) {
      const shareInfoUrl = `${hubApiBaseUrl}/api/share/${options.shareId}`;
      lines.push(`View share details and find room_id: GET ${shareInfoUrl}`);
    }

    lines.push(
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      "Do not explain internal technical details. Just tell me when it is done.",
    );
    return lines.join("\n");
  }

  const lines: string[] = [
    `这是一个 BotCord 群邀请：${options.roomName}`,
  ];

  if (options.inviteCode) {
    const previewUrl = `${hubApiBaseUrl}/api/invites/${options.inviteCode}`;
    const redeemUrl = `${hubApiBaseUrl}/api/invites/${options.inviteCode}/redeem`;
    lines.push(`查看邀请详情：GET ${previewUrl}`);
    if (!options.isReadOnly) {
      lines.push(
        options.requiresPayment
          ? `接受邀请（可能需要付费）：POST ${redeemUrl}`
          : `接受邀请：POST ${redeemUrl}`,
      );
    }
  } else if (options.roomId) {
    const joinUrl = `${hubApiBaseUrl}/hub/rooms/${options.roomId}/members`;
    lines.push(`加入群：POST ${joinUrl}`);
    lines.push(`JSON 参数：{"agent_id":"<当前 Bot 的 agent_id>"}`);
    if (options.requiresPayment) {
      lines.push("注意：该群需要付费订阅，请先完成订阅再加入。");
    }
  } else if (options.shareId) {
    const shareInfoUrl = `${hubApiBaseUrl}/api/share/${options.shareId}`;
    lines.push(`查看分享详情并获取 room_id：GET ${shareInfoUrl}`);
  }

  lines.push(
    `如果还没安装 BotCord，请先按这个说明完成安装：${installGuideUrl}`,
    "不要向我解释内部技术细节；完成后直接告诉我结果。",
  );
  return lines.join("\n");
}

export function buildFriendInvitePrompt(options: {
  inviteCode: string;
  hubApiBaseUrl?: string;
  installGuideUrl?: string;
  locale?: PromptLocale;
}): string {
  const hubApiBaseUrl = options.hubApiBaseUrl || getHubApiBaseUrl();
  const installGuideUrl = options.installGuideUrl || getBotcordInstallGuideUrl();
  const locale = resolveLocale(options.locale);
  const previewApiUrl = `${hubApiBaseUrl}/api/invites/${options.inviteCode}`;
  const redeemApiUrl = `${hubApiBaseUrl}/api/invites/${options.inviteCode}/redeem`;

  if (locale === "en") {
    return [
      "This is a BotCord friend invite.",
      `Preview invite details: GET ${previewApiUrl}`,
      `Accept the invite: POST ${redeemApiUrl}`,
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      "After accepting, just confirm it is done. Do not explain internal technical details.",
    ].join("\n");
  }

  return [
    "这是一个 BotCord 好友邀请。",
    `查看邀请详情：GET ${previewApiUrl}`,
    `接受邀请：POST ${redeemApiUrl}`,
    `如果还没安装 BotCord，请先按这个说明完成安装：${installGuideUrl}`,
    "接受后直接告诉我结果，不要解释内部技术细节。",
  ].join("\n");
}

export function buildSelfJoinPrompt(options: {
  roomId: string;
  roomName: string;
  hubApiBaseUrl?: string;
  installGuideUrl?: string;
  locale?: PromptLocale;
}): string {
  const hubApiBaseUrl = options.hubApiBaseUrl || getHubApiBaseUrl();
  const installGuideUrl = options.installGuideUrl || getBotcordInstallGuideUrl();
  const locale = resolveLocale(options.locale);
  const joinUrl = `${hubApiBaseUrl}/hub/rooms/${options.roomId}/members`;

  if (locale === "en") {
    return [
      `Help me join this BotCord group: ${options.roomName}`,
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      `Join the group: POST ${joinUrl}`,
      `JSON params: {"agent_id":"<current_bot_agent_id>"}`,
      "Do not explain internal technical details. Just tell me when it is done.",
    ].join("\n");
  }

  return [
    `帮我加入这个 BotCord 群：${options.roomName}`,
    `如果还没安装 BotCord，请先按这个说明完成安装：${installGuideUrl}`,
    `加入群：POST ${joinUrl}`,
    `JSON 参数：{"agent_id":"<当前 Bot 的 agent_id>"}`,
    "不要向我解释内部技术细节；完成后直接告诉我结果。",
  ].join("\n");
}

export function buildCreateRoomPrompt(options?: {
  locale?: PromptLocale;
}): string {
  const locale = resolveLocale(options?.locale);

  if (locale === "en") {
    return [
      "Help me create a new BotCord group.",
      "First ask only for the missing information: the group name, its purpose, whether it should be public, and who should be invited.",
      "If I do not specify anything else, choose the safer defaults: private group, invite-only access, members can send messages, and regular members cannot invite others.",
      "When it is done, do not explain internal technical fields. Just tell me the group is ready and which key settings you applied.",
    ].join("\n");
  }

  return [
    "帮我创建一个新的 BotCord 群。",
    "先只问我缺少的信息：群名称、用途、是否公开，以及需要邀请谁。",
    "如果我没有特别说明，默认用更稳妥的方式创建：私有群、需要邀请才能加入、成员可以发言、普通成员不能继续拉人。",
    "创建完成后，不要向我解释内部技术字段；只告诉我这个群已经可以开始使用，以及你替我做了哪些关键设置。",
  ].join("\n");
}
