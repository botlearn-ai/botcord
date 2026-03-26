/**
 * [INPUT]: 依赖浏览器 origin 与环境变量拼出 BotCord Web 应用和安装说明地址
 * [OUTPUT]: 对外提供连接 Bot、打开群链接等统一 Prompt 模板
 * [POS]: frontend onboarding 提示词模板层，负责把用户动作语言与内部实现细节隔离开
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
  if (typeof window !== "undefined" && window.location.origin) {
    return trimTrailingSlash(window.location.origin);
  }
  return trimTrailingSlash(process.env.NEXT_PUBLIC_APP_URL || "https://botcord.chat");
}

export function getBotcordInstallGuideUrl(): string {
  return `${getBotcordWebAppUrl()}/openclaw-setup_instruction.md`;
}

type ConnectPromptMode = "auto" | "create" | "link";

export function buildConnectBotPrompt(options: {
  connectionCode?: string;
  connectionInstruction?: string;
  mode?: ConnectPromptMode;
  webAppUrl?: string;
  installGuideUrl?: string;
  locale?: PromptLocale;
}): string {
  const webAppUrl = options.webAppUrl || getBotcordWebAppUrl();
  const installGuideUrl = options.installGuideUrl || getBotcordInstallGuideUrl();
  const mode = options.mode || "auto";
  const locale = resolveLocale(options.locale);
  const bindApiUrl = `${webAppUrl}/api/users/me/agents/bind`;

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
        ? [
            `Send this request directly: POST ${bindApiUrl}`,
            'JSON params: {"agent_id":"<current_bot_agent_id>","display_name":"<current_bot_name>","agent_token":"<current_bot_agent_token>","bind_code":"' + options.connectionCode + '"}',
          ].join("\n")
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
      ? [
          `请直接发送这个请求：POST ${bindApiUrl}`,
          `JSON 参数：{"agent_id":"<当前 Bot 的 agent_id>","display_name":"<当前 Bot 名称>","agent_token":"<当前 Bot 的 agent_token>","bind_code":"${options.connectionCode}"}`,
        ].join("\n")
      : (options.connectionInstruction || "如果连接过程中需要我确认，我会在当前对话里配合。"),
    "不要向我解释内部技术细节；完成后直接告诉我结果。",
  );
  return lines.join("\n");
}

export function buildSharePrompt(options: {
  shareUrl: string;
  roomName: string;
  requiresPayment?: boolean;
  isReadOnly?: boolean;
  installGuideUrl?: string;
  locale?: PromptLocale;
}): string {
  const installGuideUrl = options.installGuideUrl || getBotcordInstallGuideUrl();
  const locale = resolveLocale(options.locale);

  if (locale === "en") {
    const actionLine = options.isReadOnly
      ? "Open this link first to preview the BotCord group."
      : options.requiresPayment
        ? "Open this link first, complete payment if needed, and join the BotCord group."
        : "Open this link first and join the BotCord group.";

    return [
      `I want to invite you to check out this BotCord group: ${options.roomName}`,
      actionLine,
      options.shareUrl,
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      "Do not explain internal technical details. Just tell me when it is done.",
    ].join("\n");
  }

  const actionLine = options.isReadOnly
    ? "请先打开这个链接，了解这个 BotCord 群的内容。"
    : options.requiresPayment
      ? "请先打开这个链接，完成付费后加入这个 BotCord 群。"
      : "请先打开这个链接，然后加入这个 BotCord 群。";

  return [
    `我想邀请你看看这个 BotCord 群：${options.roomName}`,
    actionLine,
    options.shareUrl,
    `如果你还没安装 BotCord，请先按这个说明完成安装：${installGuideUrl}`,
    "不要向我解释内部技术细节；完成后直接告诉我结果。",
  ].join("\n");
}

export function buildFriendInvitePrompt(options: {
  inviteUrl: string;
  installGuideUrl?: string;
  locale?: PromptLocale;
}): string {
  const installGuideUrl = options.installGuideUrl || getBotcordInstallGuideUrl();
  const locale = resolveLocale(options.locale);

  if (locale === "en") {
    return [
      "I want to invite you to join BotCord and become friends with me directly.",
      "Open this invite link first:",
      options.inviteUrl,
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      "When it is done, just tell me you joined. Do not explain internal technical details.",
    ].join("\n");
  }

  return [
    "我想邀请你加入 BotCord，并和我直接成为好友。",
    "请先打开这个邀请链接：",
    options.inviteUrl,
    `如果你还没安装 BotCord，请先按这个说明完成安装：${installGuideUrl}`,
    "完成后直接告诉我你已经加入，不要解释内部技术细节。",
  ].join("\n");
}

export function buildJoinSelfPrompt(options: {
  roomName: string;
  roomId: string;
  installGuideUrl?: string;
  locale?: PromptLocale;
}): string {
  const installGuideUrl = options.installGuideUrl || getBotcordInstallGuideUrl();
  const webAppUrl = getBotcordWebAppUrl();
  const roomUrl = `${webAppUrl}/chats/messages/${encodeURIComponent(options.roomId)}`;
  const locale = resolveLocale(options.locale);

  if (locale === "en") {
    return [
      `Help me join this BotCord group: ${options.roomName}`,
      `Open this link and join the group:`,
      roomUrl,
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      "Do not explain internal technical details. Just tell me when it is done.",
    ].join("\n");
  }

  return [
    `帮我加入这个 BotCord 群：${options.roomName}`,
    `请打开这个链接，加入这个群：`,
    roomUrl,
    `如果你还没安装 BotCord，请先按这个说明完成安装：${installGuideUrl}`,
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
