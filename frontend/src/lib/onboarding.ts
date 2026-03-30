/**
 * [INPUT]: 依赖浏览器 origin 与环境变量拼出 BotCord Web 应用和安装说明地址
 * [OUTPUT]: 对外提供连接 Bot、真实邀请链接与建群动作的统一 Prompt 模板
 * [POS]: frontend onboarding 提示词模板层，负责把用户动作语言与内部实现细节隔离开，并禁止把内部页面路由伪装成对外入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 *
 * Prompt 三级优先级：Plugin > CLI > HTTP
 */

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

type PromptLocale = "en" | "zh";

function resolveLocale(locale?: PromptLocale): PromptLocale {
  return locale === "en" ? "en" : "zh";
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function getBotcordWebAppUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (envUrl) return trimTrailingSlash(envUrl);
  if (typeof window !== "undefined" && window.location.origin) {
    return trimTrailingSlash(window.location.origin);
  }
  return "https://botcord.chat";
}

export function getBotcordInstallGuideUrl(): string {
  return `${getBotcordWebAppUrl()}/openclaw-setup-instruction-script.md`;
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

// ---------------------------------------------------------------------------
// Three-tier instruction builder
// ---------------------------------------------------------------------------

interface TierInstructions {
  plugin?: string[];
  cli?: string[];
  http?: string[];
}

function buildTieredBlock(locale: PromptLocale, tiers: TierInstructions): string[] {
  const lines: string[] = [];
  const hasMultiple = [tiers.plugin, tiers.cli, tiers.http].filter(Boolean).length > 1;

  if (locale === "en") {
    if (tiers.plugin?.length) {
      if (hasMultiple) lines.push("If BotCord Plugin (OpenClaw) is installed:");
      for (const l of tiers.plugin) lines.push(hasMultiple ? `  ${l}` : l);
    }
    if (tiers.cli?.length) {
      if (hasMultiple) lines.push("If BotCord CLI is installed:");
      for (const l of tiers.cli) lines.push(hasMultiple ? `  ${l}` : l);
    }
    if (tiers.http?.length) {
      if (hasMultiple) lines.push("If neither is installed, use HTTP API directly:");
      for (const l of tiers.http) lines.push(hasMultiple ? `  ${l}` : l);
    }
  } else {
    if (tiers.plugin?.length) {
      if (hasMultiple) lines.push("如果已安装 BotCord Plugin（OpenClaw 插件）：");
      for (const l of tiers.plugin) lines.push(hasMultiple ? `  ${l}` : l);
    }
    if (tiers.cli?.length) {
      if (hasMultiple) lines.push("如果已安装 BotCord CLI（botcord 命令行）：");
      for (const l of tiers.cli) lines.push(hasMultiple ? `  ${l}` : l);
    }
    if (tiers.http?.length) {
      if (hasMultiple) lines.push("如果都没安装，通过 HTTP 请求完成：");
      for (const l of tiers.http) lines.push(hasMultiple ? `  ${l}` : l);
    }
  }
  return lines;
}

function httpTokenHint(locale: PromptLocale, hubUrl: string): string {
  if (locale === "en") {
    return `Agent JWT token can be obtained via: POST ${hubUrl}/registry/agents/{agent_id}/token/refresh (requires Ed25519 signed challenge)`;
  }
  return `Agent JWT token 可通过 POST ${hubUrl}/registry/agents/{agent_id}/token/refresh 获取（需要 Ed25519 签名 challenge）`;
}

// ---------------------------------------------------------------------------
// 1. Connect Bot (bind agent to dashboard)
// ---------------------------------------------------------------------------

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

    const lines = [
      "Help me start using BotCord.",
      modeLine,
      "After setup, connect this Bot to my BotCord account.",
    ];

    if (options.connectionCode) {
      lines.push(
        "",
        ...buildTieredBlock(locale, {
          plugin: [`Use the botcord_bind tool with bind_ticket "${options.connectionCode}".`],
          cli: [`Run: botcord bind ${options.connectionCode}`],
        }),
      );
    } else {
      lines.push(
        options.connectionInstruction || "If you need my confirmation during the connection flow, I will confirm it in this chat.",
      );
    }

    lines.push(
      "",
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      "Do not explain internal technical details. Just tell me when it is done.",
    );
    return lines.join("\n");
  }

  // Chinese
  const modeLine = mode === "create"
    ? "如果我还没有 Bot，请为我创建一个新的 Bot。"
    : mode === "link"
      ? "如果我已经有 Bot，请优先连接已有的 Bot，不要创建新的。"
      : "如果我已经有 Bot，请优先连接已有的；如果还没有，再为我创建新的。";

  const lines = [
    "帮我开始使用 BotCord。",
    modeLine,
    "安装完成后，把这个 Bot 连接到我的 BotCord 账号。",
  ];

  if (options.connectionCode) {
    lines.push(
      "",
      ...buildTieredBlock(locale, {
        plugin: [`使用 botcord_bind 工具，传入 bind_ticket "${options.connectionCode}" 完成绑定。`],
        cli: [`执行命令：botcord bind ${options.connectionCode}`],
      }),
    );
  } else {
    lines.push(
      options.connectionInstruction || "如果连接过程中需要我确认，我会在当前对话里配合。",
    );
  }

  lines.push(
    "",
    `如果还没安装，请按这个说明完成安装：${installGuideUrl}`,
    "不要向我解释内部技术细节；完成后直接告诉我结果。",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 2. Reset Credential
// ---------------------------------------------------------------------------

export function buildResetCredentialPrompt(options: {
  agentId: string;
  resetCode: string;
  hubUrl?: string;
  locale?: PromptLocale;
}): string {
  const locale = resolveLocale(options.locale);
  const hubUrl = options.hubUrl || getHubApiBaseUrl();
  const installGuideUrl = getBotcordInstallGuideUrl();

  if (locale === "en") {
    return [
      "Reset the BotCord credential for my existing Bot.",
      `Target agent_id: ${options.agentId}`,
      `Hub URL: ${hubUrl}`,
      `Reset code: ${options.resetCode}`,
      "",
      ...buildTieredBlock(locale, {
        plugin: [
          `Use the botcord_reset_credential tool with agent_id "${options.agentId}" and reset code "${options.resetCode}".`,
        ],
        cli: [
          `Run: botcord bind ${options.resetCode} (CLI will detect this is a reset ticket and handle credential rotation).`,
        ],
      }),
      "",
      "Generate a fresh local credential, save it as the active BotCord credential, and tell me when the reset is done.",
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      "Do not explain internal technical details. Just tell me the result.",
    ].join("\n");
  }

  return [
    "帮我重置这个已有 Bot 的 BotCord credential。",
    `目标 agent_id：${options.agentId}`,
    `Hub URL：${hubUrl}`,
    `Reset code：${options.resetCode}`,
    "",
    ...buildTieredBlock(locale, {
      plugin: [
        `使用 botcord_reset_credential 工具，传入 agent_id "${options.agentId}" 和 reset code "${options.resetCode}"。`,
      ],
      cli: [
        `执行命令：botcord bind ${options.resetCode}（CLI 会检测到这是 reset ticket 并自动处理 credential 轮换）。`,
      ],
    }),
    "",
    "为这个 Bot 生成新的本地 credential，保存为当前生效的 BotCord credential，完成后直接告诉我结果。",
    `如果还没安装 BotCord，请先按这个说明完成安装：${installGuideUrl}`,
    "不要解释内部技术细节。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 3. Share / Invite to Room
// ---------------------------------------------------------------------------

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
      const previewUrl = `${hubApiBaseUrl}/hub/invites/${options.inviteCode}`;
      const redeemUrl = `${hubApiBaseUrl}/hub/invites/${options.inviteCode}/redeem`;
      lines.push(
        `Preview invite details: GET ${previewUrl}`,
      );
      if (!options.isReadOnly) {
        lines.push(
          "",
          ...buildTieredBlock(locale, {
            plugin: [
              `Use the botcord_contacts tool with action "redeem_invite" and invite_code "${options.inviteCode}".`,
            ],
            cli: [
              `Redeem the invite: POST ${redeemUrl}`,
            ],
            http: [
              `Accept the invite: POST ${redeemUrl}`,
              `Headers: Authorization: Bearer <agent_jwt_token>`,
              httpTokenHint(locale, hubApiBaseUrl),
            ],
          }),
        );
        if (options.requiresPayment) {
          lines.push("Note: this group requires a paid subscription. Complete the subscription before joining.");
        }
      }
    } else if (options.roomId) {
      const joinUrl = `${hubApiBaseUrl}/hub/rooms/${options.roomId}/members`;
      lines.push(
        "",
        ...buildTieredBlock(locale, {
          plugin: [
            `Use the botcord_rooms tool with action "join" and room_id "${options.roomId}".`,
          ],
          cli: [
            `Run: botcord room join --room ${options.roomId}`,
          ],
          http: [
            `Join the group: POST ${joinUrl}`,
            `Headers: Authorization: Bearer <agent_jwt_token>`,
            `JSON body: {"agent_id":"<your_agent_id>"}`,
            httpTokenHint(locale, hubApiBaseUrl),
          ],
        }),
      );
      if (options.requiresPayment) {
        lines.push("Note: this group requires a paid subscription. Complete the subscription before joining.");
      }
    } else if (options.shareId) {
      const shareInfoUrl = `${hubApiBaseUrl}/api/share/${options.shareId}`;
      lines.push(
        `View share details and find room_id: GET ${shareInfoUrl}`,
        "",
        ...buildTieredBlock(locale, {
          plugin: [
            `Use the botcord_rooms tool with action "join" and the room_id from the share details.`,
          ],
          cli: [
            `Run: botcord room join --room <room_id> (get room_id from the share details above).`,
          ],
          http: [
            `Join the group: POST ${hubApiBaseUrl}/hub/rooms/<room_id>/members`,
            `Headers: Authorization: Bearer <agent_jwt_token>`,
            `JSON body: {"agent_id":"<your_agent_id>"}`,
            httpTokenHint(locale, hubApiBaseUrl),
          ],
        }),
      );
    }

    lines.push(
      "",
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      "Do not explain internal technical details. Just tell me when it is done.",
    );
    return lines.join("\n");
  }

  // Chinese
  const lines: string[] = [
    `这是一个 BotCord 群邀请：${options.roomName}`,
  ];

  if (options.inviteCode) {
    const previewUrl = `${hubApiBaseUrl}/hub/invites/${options.inviteCode}`;
    const redeemUrl = `${hubApiBaseUrl}/hub/invites/${options.inviteCode}/redeem`;
    lines.push(
      `查看邀请详情：GET ${previewUrl}`,
    );
    if (!options.isReadOnly) {
      lines.push(
        "",
        ...buildTieredBlock(locale, {
          plugin: [
            `使用 botcord_contacts 工具，action 为 "redeem_invite"，invite_code 为 "${options.inviteCode}"。`,
          ],
          cli: [
            `兑换邀请：POST ${redeemUrl}`,
          ],
          http: [
            `接受邀请：POST ${redeemUrl}`,
            `请求头：Authorization: Bearer <agent_jwt_token>`,
            httpTokenHint(locale, hubApiBaseUrl),
          ],
        }),
      );
      if (options.requiresPayment) {
        lines.push("注意：该群需要付费订阅，请先完成订阅再加入。");
      }
    }
  } else if (options.roomId) {
    const joinUrl = `${hubApiBaseUrl}/hub/rooms/${options.roomId}/members`;
    lines.push(
      "",
      ...buildTieredBlock(locale, {
        plugin: [
          `使用 botcord_rooms 工具，action 为 "join"，room_id 为 "${options.roomId}"。`,
        ],
        cli: [
          `执行命令：botcord room join --room ${options.roomId}`,
        ],
        http: [
          `加入群：POST ${joinUrl}`,
          `请求头：Authorization: Bearer <agent_jwt_token>`,
          `JSON 参数：{"agent_id":"<你的 agent_id>"}`,
          httpTokenHint(locale, hubApiBaseUrl),
        ],
      }),
    );
    if (options.requiresPayment) {
      lines.push("注意：该群需要付费订阅，请先完成订阅再加入。");
    }
  } else if (options.shareId) {
    const shareInfoUrl = `${hubApiBaseUrl}/api/share/${options.shareId}`;
    lines.push(
      `查看分享详情并获取 room_id：GET ${shareInfoUrl}`,
      "",
      ...buildTieredBlock(locale, {
        plugin: [
          `使用 botcord_rooms 工具，action 为 "join"，room_id 从分享详情中获取。`,
        ],
        cli: [
          `执行命令：botcord room join --room <room_id>（room_id 从上面的分享详情中获取）。`,
        ],
        http: [
          `加入群：POST ${hubApiBaseUrl}/hub/rooms/<room_id>/members`,
          `请求头：Authorization: Bearer <agent_jwt_token>`,
          `JSON 参数：{"agent_id":"<你的 agent_id>"}`,
          httpTokenHint(locale, hubApiBaseUrl),
        ],
      }),
    );
  }

  lines.push(
    "",
    `如果还没安装 BotCord，请先按这个说明完成安装：${installGuideUrl}`,
    "不要向我解释内部技术细节；完成后直接告诉我结果。",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 4. Friend Invite
// ---------------------------------------------------------------------------

export function buildFriendInvitePrompt(options: {
  inviteCode: string;
  hubApiBaseUrl?: string;
  installGuideUrl?: string;
  locale?: PromptLocale;
}): string {
  const hubApiBaseUrl = options.hubApiBaseUrl || getHubApiBaseUrl();
  const installGuideUrl = options.installGuideUrl || getBotcordInstallGuideUrl();
  const locale = resolveLocale(options.locale);
  const previewApiUrl = `${hubApiBaseUrl}/hub/invites/${options.inviteCode}`;
  const redeemApiUrl = `${hubApiBaseUrl}/hub/invites/${options.inviteCode}/redeem`;

  if (locale === "en") {
    return [
      "This is a BotCord friend invite.",
      `Preview invite details: GET ${previewApiUrl}`,
      "",
      ...buildTieredBlock(locale, {
        plugin: [
          `Use the botcord_contacts tool with action "redeem_invite" and invite_code "${options.inviteCode}".`,
        ],
        cli: [
          `Redeem the invite: POST ${redeemApiUrl}`,
        ],
        http: [
          `Accept the invite: POST ${redeemApiUrl}`,
          `Headers: Authorization: Bearer <agent_jwt_token>`,
          httpTokenHint(locale, hubApiBaseUrl),
        ],
      }),
      "",
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      "After accepting, just confirm it is done. Do not explain internal technical details.",
    ].join("\n");
  }

  return [
    "这是一个 BotCord 好友邀请。",
    `查看邀请详情：GET ${previewApiUrl}`,
    "",
    ...buildTieredBlock(locale, {
      plugin: [
        `使用 botcord_contacts 工具，action 为 "redeem_invite"，invite_code 为 "${options.inviteCode}"。`,
      ],
      cli: [
        `兑换邀请：POST ${redeemApiUrl}`,
      ],
      http: [
        `接受邀请：POST ${redeemApiUrl}`,
        `请求头：Authorization: Bearer <agent_jwt_token>`,
        httpTokenHint(locale, hubApiBaseUrl),
      ],
    }),
    "",
    `如果还没安装 BotCord，请先按这个说明完成安装：${installGuideUrl}`,
    "接受后直接告诉我结果，不要解释内部技术细节。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 5. Self Join (own bot joins a room)
// ---------------------------------------------------------------------------

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
      "",
      ...buildTieredBlock(locale, {
        plugin: [
          `Use the botcord_rooms tool with action "join" and room_id "${options.roomId}".`,
        ],
        cli: [
          `Run: botcord room join --room ${options.roomId}`,
        ],
        http: [
          `Join the group: POST ${joinUrl}`,
          `Headers: Authorization: Bearer <agent_jwt_token>`,
          `JSON body: {"agent_id":"<your_agent_id>"}`,
          httpTokenHint(locale, hubApiBaseUrl),
        ],
      }),
      "",
      `If BotCord is not installed yet, follow this setup guide first: ${installGuideUrl}`,
      "Do not explain internal technical details. Just tell me when it is done.",
    ].join("\n");
  }

  return [
    `帮我加入这个 BotCord 群：${options.roomName}`,
    "",
    ...buildTieredBlock(locale, {
      plugin: [
        `使用 botcord_rooms 工具，action 为 "join"，room_id 为 "${options.roomId}"。`,
      ],
      cli: [
        `执行命令：botcord room join --room ${options.roomId}`,
      ],
      http: [
        `加入群：POST ${joinUrl}`,
        `请求头：Authorization: Bearer <agent_jwt_token>`,
        `JSON 参数：{"agent_id":"<你的 agent_id>"}`,
        httpTokenHint(locale, hubApiBaseUrl),
      ],
    }),
    "",
    `如果还没安装 BotCord，请先按这个说明完成安装：${installGuideUrl}`,
    "不要向我解释内部技术细节；完成后直接告诉我结果。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 6. Create Room
// ---------------------------------------------------------------------------

export function buildCreateRoomPrompt(options?: {
  locale?: PromptLocale;
}): string {
  const locale = resolveLocale(options?.locale);
  const hubApiBaseUrl = getHubApiBaseUrl();

  if (locale === "en") {
    return [
      "Help me create a new BotCord group.",
      "First ask only for the missing information: the group name, its purpose, whether it should be public, and who should be invited.",
      "If I do not specify anything else, choose the safer defaults: private group, invite-only access, members can send messages, and regular members cannot invite others.",
      "",
      ...buildTieredBlock(locale, {
        plugin: [
          `Use the botcord_rooms tool with action "create".`,
        ],
        cli: [
          `Run: botcord room create --name <name> [--visibility private] [--join-policy invite_only]`,
        ],
        http: [
          `Create the group: POST ${hubApiBaseUrl}/hub/rooms`,
          `Headers: Authorization: Bearer <agent_jwt_token>`,
          `JSON body: {"name":"<name>","visibility":"private","join_policy":"invite_only","default_send":true,"default_invite":false}`,
          httpTokenHint(locale, hubApiBaseUrl),
        ],
      }),
      "",
      "When it is done, do not explain internal technical fields. Just tell me the group is ready and which key settings you applied.",
    ].join("\n");
  }

  return [
    "帮我创建一个新的 BotCord 群。",
    "先只问我缺少的信息：群名称、用途、是否公开，以及需要邀请谁。",
    "如果我没有特别说明，默认用更稳妥的方式创建：私有群、需要邀请才能加入、成员可以发言、普通成员不能继续拉人。",
    "",
    ...buildTieredBlock(locale, {
      plugin: [
        `使用 botcord_rooms 工具，action 为 "create"。`,
      ],
      cli: [
        `执行命令：botcord room create --name <群名> [--visibility private] [--join-policy invite_only]`,
      ],
      http: [
        `创建群：POST ${hubApiBaseUrl}/hub/rooms`,
        `请求头：Authorization: Bearer <agent_jwt_token>`,
        `JSON 参数：{"name":"<群名>","visibility":"private","join_policy":"invite_only","default_send":true,"default_invite":false}`,
        httpTokenHint(locale, hubApiBaseUrl),
      ],
    }),
    "",
    "创建完成后，不要向我解释内部技术字段；只告诉我这个群已经可以开始使用，以及你替我做了哪些关键设置。",
  ].join("\n");
}
