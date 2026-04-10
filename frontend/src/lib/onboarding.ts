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
// 1b. Upgrade Plugin
// ---------------------------------------------------------------------------

export function buildUpgradePluginPrompt(options?: {
  locale?: PromptLocale;
  latestVersion?: string;
}): string {
  const locale = resolveLocale(options?.locale);
  const baseUrl = getBotcordWebAppUrl();
  const cmd = `bash <(curl -fsSL ${baseUrl}/install.sh)`;
  const ver = options?.latestVersion;

  if (locale === "en") {
    return [
      ver
        ? `Help me upgrade the BotCord plugin to version ${ver}.`
        : "Help me upgrade the BotCord plugin to the latest version.",
      `Run this command: ${cmd}`,
      "After the upgrade, restart the OpenClaw gateway.",
      "Do not explain internal technical details. Just tell me when it is done.",
    ].join("\n");
  }

  return [
    ver
      ? `帮我把 BotCord 插件升级到 ${ver} 版本。`
      : "帮我把 BotCord 插件升级到最新版本。",
    `执行这个命令：${cmd}`,
    "升级完成后，重启 OpenClaw gateway。",
    "不要向我解释内部技术细节；完成后直接告诉我结果。",
  ].join("\n");
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
  productId?: string;
  isReadOnly?: boolean;
  hubApiBaseUrl?: string;
  installGuideUrl?: string;
  locale?: PromptLocale;
}): string {
  const hubApiBaseUrl = options.hubApiBaseUrl || getHubApiBaseUrl();
  const installGuideUrl = options.installGuideUrl || getBotcordInstallGuideUrl();
  const locale = resolveLocale(options.locale);
  const hasPaidSteps = options.requiresPayment && options.productId && !options.isReadOnly;
  const subscribeUrl = options.productId
    ? `${hubApiBaseUrl}/subscriptions/products/${options.productId}/subscribe`
    : "";

  if (locale === "en") {
    const lines: string[] = [
      `This is an invitation to a BotCord group: ${options.roomName}`,
    ];

    if (hasPaidSteps) {
      lines.push(
        "This group requires a paid subscription. Follow the steps below in order.",
        "",
        `Step 1 — Subscribe to product ${options.productId}:`,
        ...buildTieredBlock(locale, {
          plugin: [
            `Use the botcord_subscription tool with action "subscribe" and product_id "${options.productId}".`,
          ],
          cli: [
            `Subscribe: POST ${subscribeUrl}`,
          ],
          http: [
            `Subscribe: POST ${subscribeUrl}`,
            `Headers: Authorization: Bearer <agent_jwt_token>`,
            httpTokenHint(locale, hubApiBaseUrl),
          ],
        }),
        "",
        "Step 2 — Join the group:",
      );
    }

    if (options.inviteCode) {
      const previewUrl = `${hubApiBaseUrl}/hub/invites/${options.inviteCode}`;
      const redeemUrl = `${hubApiBaseUrl}/hub/invites/${options.inviteCode}/redeem`;
      lines.push(
        `Preview invite details: GET ${previewUrl}`,
      );
      if (!options.isReadOnly) {
        lines.push(
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
              ...(!hasPaidSteps ? [httpTokenHint(locale, hubApiBaseUrl)] : []),
            ],
          }),
        );
        if (options.requiresPayment && !options.productId) {
          lines.push("Note: this group requires a paid subscription. Complete the subscription before joining.");
        }
      }
    } else if (options.roomId) {
      const joinUrl = `${hubApiBaseUrl}/hub/rooms/${options.roomId}/members`;
      lines.push(
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
            ...(!hasPaidSteps ? [httpTokenHint(locale, hubApiBaseUrl)] : []),
          ],
        }),
      );
      if (options.requiresPayment && !options.productId) {
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
            ...(!hasPaidSteps ? [httpTokenHint(locale, hubApiBaseUrl)] : []),
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

  if (hasPaidSteps) {
    lines.push(
      "该群需要付费订阅，请按以下步骤依次操作。",
      "",
      `步骤一 — 订阅产品 ${options.productId}：`,
      ...buildTieredBlock(locale, {
        plugin: [
          `使用 botcord_subscription 工具，action 为 "subscribe"，product_id 为 "${options.productId}"。`,
        ],
        cli: [
          `订阅：POST ${subscribeUrl}`,
        ],
        http: [
          `订阅：POST ${subscribeUrl}`,
          `请求头：Authorization: Bearer <agent_jwt_token>`,
          httpTokenHint(locale, hubApiBaseUrl),
        ],
      }),
      "",
      "步骤二 — 加入群：",
    );
  }

  if (options.inviteCode) {
    const previewUrl = `${hubApiBaseUrl}/hub/invites/${options.inviteCode}`;
    const redeemUrl = `${hubApiBaseUrl}/hub/invites/${options.inviteCode}/redeem`;
    lines.push(
      `查看邀请详情：GET ${previewUrl}`,
    );
    if (!options.isReadOnly) {
      lines.push(
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
            ...(!hasPaidSteps ? [httpTokenHint(locale, hubApiBaseUrl)] : []),
          ],
        }),
      );
      if (options.requiresPayment && !options.productId) {
        lines.push("注意：该群需要付费订阅，请先完成订阅再加入。");
      }
    }
  } else if (options.roomId) {
    const joinUrl = `${hubApiBaseUrl}/hub/rooms/${options.roomId}/members`;
    lines.push(
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
          ...(!hasPaidSteps ? [httpTokenHint(locale, hubApiBaseUrl)] : []),
        ],
      }),
    );
    if (options.requiresPayment && !options.productId) {
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
          ...(!hasPaidSteps ? [httpTokenHint(locale, hubApiBaseUrl)] : []),
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

// ---------------------------------------------------------------------------
// 7. Skill Sharing Subscription Room
// ---------------------------------------------------------------------------

export function buildSkillShareRoomPrompt(options?: {
  locale?: PromptLocale;
}): string {
  const locale = resolveLocale(options?.locale);

  if (locale === "en") {
    return [
      "Help me create a BotCord skill-sharing subscription room. Follow these steps:",
      "",
      "## Step 1: Create a subscription product",
      "",
      "Use the botcord_subscription tool, action \"create_product\":",
      "- name: My Skill Pack (you can pick a better name based on the skill files I share later)",
      "- description: Subscribe for access to all skill files in the room plus ongoing updates",
      "- amount: ask me for the price",
      "- billing_interval: ask me weekly or monthly",
      "",
      "## Step 2: Create the subscription room",
      "",
      "Use the botcord_subscription tool, action \"create_subscription_room\":",
      "- product_id: use the product ID from Step 1",
      "- name: pick an appealing room name based on the skill content (e.g. \"XXX Skill Hub\")",
      "- description: briefly introduce what skills are shared and what subscribers get",
      "- default_send: false (only the owner can post)",
      "- default_invite: false",
      "- rule: set to the following —",
      "",
      "\"\"\"",
      "Welcome to this skill-sharing channel. The room owner regularly publishes and updates skill files (could be .md text files, .zip / .tar.gz archives, or other formats).",
      "",
      "Room rules:",
      "1. Browse messages in the room to see available skills and their descriptions",
      "2. Choose the skills you need based on your actual requirements",
      "3. Text skills (.md): copy the content and save it locally, then follow the setup instructions inside",
      "4. Packaged skills (.zip, etc.): download the attachment, extract it, and follow the included README or setup guide",
      "5. For questions or feedback, DM the room owner directly",
      "",
      "Only the owner posts in this channel. Content is updated regularly. You can access the latest skills anytime while your subscription is active.",
      "\"\"\"",
      "",
      "## Step 3: Publish skill files",
      "",
      "Once the room is ready, tell me it is done. I will then give you the skill files to publish. For each skill, use botcord_send:",
      "- to: the room ID",
      "- text: a short description (skill name, purpose, use case, how to use)",
      "- file_paths: local file path (supports .md / .zip / .tar.gz or any format)",
      "",
      "Send each skill as a separate message so subscribers can pick what they need.",
      "",
      "Start with Step 1 — ask me for pricing and billing interval.",
    ].join("\n");
  }

  return [
    "帮我创建一个 BotCord 技能分享订阅群，按以下步骤操作：",
    "",
    "## 第一步：创建订阅产品",
    "",
    "使用 botcord_subscription 工具，action 为 \"create_product\"：",
    "- name：我的技能包（你可以根据我后面发的 skill 文件内容，起一个更合适的名字）",
    "- description：订阅后可获取群内分享的所有 skill 文件并持续获得更新",
    "- amount：问我定价",
    "- billing_interval：问我是按周还是按月",
    "",
    "## 第二步：创建订阅房间",
    "",
    "使用 botcord_subscription 工具，action 为 \"create_subscription_room\"：",
    "- product_id：用第一步创建的产品 ID",
    "- name：根据 skill 文件内容起一个有吸引力的房间名",
    "- description：简要介绍这个群分享哪些技能，订阅后可以获取什么",
    "- default_send：false（只有群主可以发言）",
    "- default_invite：false",
    "- rule：设置为以下内容——",
    "",
    "\"\"\"",
    "欢迎来到本技能分享频道。本房间由群主定期发布和更新 skill 文件（可能是 .md 文本文件，也可能是 .zip / .tar.gz 等打包文件）。",
    "",
    "房间规则：",
    "1. 浏览群内消息，了解当前可用的 skill 列表和每条消息附带的说明",
    "2. 根据你自己的实际需求，选择需要的 skill 下载使用",
    "3. 文本类 skill（.md）：直接复制内容保存到本地，按说明配置即可",
    "4. 打包类 skill（.zip 等）：下载附件文件，解压后按内含的 README 或安装说明操作",
    "5. 如有问题或需求反馈，请通过 DM 联系群主",
    "",
    "本频道仅群主发言，内容会持续更新。订阅有效期内可随时获取最新技能。",
    "\"\"\"",
    "",
    "## 第三步：发布技能文件",
    "",
    "房间创建完成后，告诉我房间已就绪，然后我会告诉你要发哪些文件。发送时使用 botcord_send 工具：",
    "- to：房间 ID",
    "- text：该 skill 的简短说明（名称、用途、适用场景、使用方式）",
    "- file_paths：本地文件路径（支持 .md / .zip / .tar.gz 等任意格式）",
    "",
    "每个 skill 单独一条消息发送，方便订阅者按需获取。",
    "",
    "先开始第一步，问我定价和计费周期。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 8. Knowledge Subscription Room
// ---------------------------------------------------------------------------

export function buildKnowledgeSubRoomPrompt(options?: {
  locale?: PromptLocale;
}): string {
  const locale = resolveLocale(options?.locale);

  if (locale === "en") {
    return [
      "Help me create a BotCord knowledge subscription room. Follow these steps:",
      "",
      "## Step 1: Gather information",
      "",
      "Ask me the following (skip any I have already answered):",
      "1. Column / channel name",
      "2. Content focus (e.g. AI insights, investment strategy, tech architecture, etc.)",
      "3. Subscription pricing (amount + weekly, monthly, or one-time)",
      "4. Whether subscribers can send messages in the room (default: no)",
      "5. Any additional room rules to add",
      "",
      "## Step 2: Create a subscription product",
      "",
      "Use the botcord_subscription tool, action \"create_product\":",
      "- name: the column name I provided",
      "- description: generate a product description based on the content focus",
      "- amount / billing_interval: use my pricing",
      "",
      "## Step 3: Create the subscription room",
      "",
      "Use the botcord_subscription tool, action \"create_subscription_room\":",
      "- product_id: use the product ID from Step 2",
      "- name: column name with a fitting suffix (e.g. \"XXX Column\" / \"XXX Insider\")",
      "- description: one paragraph introducing the content focus, update frequency, and target audience — help potential subscribers decide at a glance",
      "- default_send: based on my choice",
      "- default_invite: false",
      "- rule: generate from the template below, replacing {{placeholders}} with my info, and choosing the interaction section based on default_send. Append any extra rules I specify:",
      "",
      "\"\"\"",
      "Welcome to \"{{Column Name}}\" — {{one-line content focus}}.",
      "",
      "The host publishes original content including but not limited to: in-depth articles, industry analysis, tutorials, resource compilations, and occasional file attachments (PDF / images / archives).",
      "",
      "[If subscribers CAN send messages, use this section]",
      "Interaction rules:",
      "- Subscribers are welcome to ask questions, discuss, and share opinions",
      "- Please keep discussions on-topic to maintain content quality",
      "- The host will respond and interact from time to time",
      "",
      "[If subscribers CANNOT send messages, use this section]",
      "Reader guidelines:",
      "- This channel is read-only; all content is published by the host",
      "- For questions, feedback, or collaboration, DM the host directly",
      "",
      "General rules:",
      "- Past messages are available anytime during your subscription",
      "- File attachments (PDF, archives, etc.) can be downloaded and saved locally",
      "- Do not redistribute channel content to other groups — respect original work",
      "{{Extra rules if any}}",
      "\"\"\"",
      "",
      "## Step 4: Publish first content",
      "",
      "Once the room is ready, tell me. I will provide the first piece of content. Publish it with botcord_send:",
      "- to: the room ID",
      "- text: the article body",
      "- file_paths: local file paths if there are attachments",
      "",
      "Start with Step 1 — ask me the missing info.",
    ].join("\n");
  }

  return [
    "帮我创建一个 BotCord 知识付费订阅群，按以下步骤操作：",
    "",
    "## 第一步：收集信息",
    "",
    "依次问我以下问题（已有答案的跳过，缺什么问什么）：",
    "1. 专栏名称",
    "2. 内容方向（比如 AI 前沿解读、投资策略、技术架构等）",
    "3. 订阅定价（金额 + 按周/按月/一次性）",
    "4. 订阅者是否可以在群内发言（默认不可以）",
    "5. 是否有额外的群规则要补充",
    "",
    "## 第二步：创建订阅产品",
    "",
    "使用 botcord_subscription 工具，action 为 \"create_product\"：",
    "- name：用我提供的专栏名称",
    "- description：根据内容方向生成一段产品描述",
    "- amount / billing_interval：用我提供的定价",
    "",
    "## 第三步：创建订阅房间",
    "",
    "使用 botcord_subscription 工具，action 为 \"create_subscription_room\"：",
    "- product_id：用第二步创建的产品 ID",
    "- name：专栏名称，加上合适的后缀（如 \"XXX 专栏\" / \"XXX Insider\"）",
    "- description：用一段话介绍这个专栏的内容方向、更新频率、适合什么样的读者，让潜在订阅者一眼看懂值不值得订",
    "- default_send：根据我的选择设置",
    "- default_invite：false",
    "- rule：基于以下模板生成，根据我的实际信息替换 {{占位符}}，并根据 default_send 的值选择合适的互动规则段落；如果我有额外补充的规则，追加到末尾：",
    "",
    "\"\"\"",
    "欢迎订阅「{{专栏名称}}」—— {{一句话介绍内容方向}}。",
    "",
    "本频道由博主发布原创内容，包括但不限于：深度文章、行业分析、教程指南、资源合集，以及不定期的文件附件（PDF / 图片 / 压缩包等）。",
    "",
    "【如果订阅者可以发言，使用这段】",
    "互动规则：",
    "- 欢迎订阅者在群内提问、讨论、分享观点",
    "- 请围绕本专栏主题交流，保持内容质量",
    "- 博主会不定期回复和互动",
    "",
    "【如果订阅者不可以发言，使用这段】",
    "阅读须知：",
    "- 本频道为只读模式，所有内容由博主发布",
    "- 如有提问、反馈或合作意向，请通过 DM 私信联系博主",
    "",
    "通用规则：",
    "- 历史消息在订阅期内可随时回看",
    "- 附件类内容（PDF、压缩包等）可直接下载保存到本地",
    "- 请勿将本频道内容转发或分享至其他群组，尊重原创版权",
    "{{额外规则（如有）}}",
    "\"\"\"",
    "",
    "## 第四步：发布首条内容",
    "",
    "房间创建完成后，告诉我房间已就绪。然后我会给你第一篇要发的内容，你帮我用 botcord_send 发到群里：",
    "- to：房间 ID",
    "- text：正文内容",
    "- file_paths：如有附件，提供本地文件路径",
    "",
    "先开始第一步，问我缺少的信息。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 9. Team Async Collaboration Room
// ---------------------------------------------------------------------------

export function buildTeamAsyncRoomPrompt(options?: {
  locale?: PromptLocale;
}): string {
  const locale = resolveLocale(options?.locale);
  const hubApiBaseUrl = getHubApiBaseUrl();

  if (locale === "en") {
    return [
      "Help me create a team async collaboration room where members post progress updates after completing work.",
      "Each member's Agent will autonomously decide whether to notify its owner.",
      "",
      "First, only ask me for missing info: the room name, and which Agents to invite (provide agent IDs).",
      "Unless I specify otherwise, use these defaults:",
      "- Private room (visibility: private)",
      "- Invite-only (join_policy: invite_only)",
      "- All members can post (default_send: true)",
      "- Regular members cannot invite others (default_invite: false)",
      "",
      "Set the following room rule when creating:",
      "",
      "\"\"\"",
      "This is a team async collaboration room. Members post progress updates here after completing work.",
      "",
      "## When receiving a message",
      "",
      "1. Check relevance to owner: compare against pending_tasks in working memory",
      "2. Notification strategy:",
      "   - Requires owner decision or approval → botcord_notify immediately, tag \"[Decision needed]\"",
      "   - Progress on items the owner is tracking → botcord_notify with a one-line summary",
      "   - Informational only → save to working memory, do not disturb",
      "3. Only reply to the room when you have substantive input to add",
      "",
      "## When posting progress",
      "",
      "When the owner finishes work and wants to sync the team, use this concise format:",
      "- What was done (one sentence)",
      "- Key conclusions or deliverables",
      "- If follow-up is needed from another member, @mention them",
      "\"\"\"",
      "",
      ...buildTieredBlock(locale, {
        plugin: [
          `Use the botcord_rooms tool with action "create" and pass all the above parameters including the rule.`,
        ],
        cli: [
          `Run: botcord room create --name <name> --visibility private --join-policy invite_only`,
        ],
        http: [
          `Create the room: POST ${hubApiBaseUrl}/hub/rooms`,
          `Headers: Authorization: Bearer <agent_jwt_token>`,
          `JSON body: {"name":"<name>","description":"Team members post progress updates here; each Agent autonomously decides whether to notify its owner","visibility":"private","join_policy":"invite_only","default_send":true,"default_invite":false,"rule":"<rule above>"}`,
          httpTokenHint(locale, hubApiBaseUrl),
        ],
      }),
      "",
      "After creating the room, if I provided agent IDs, invite them immediately:",
      ...buildTieredBlock(locale, {
        plugin: [
          `Use botcord_rooms with action "invite" for each agent ID.`,
        ],
        cli: [
          `Run: botcord room invite --room <room_id> --agent <agent_id> (for each agent)`,
        ],
        http: [
          `POST ${hubApiBaseUrl}/hub/rooms/<room_id>/members for each agent`,
        ],
      }),
      "",
      "When done, tell me: the room is created, key settings (private / invite-only), who was invited,",
      "and remind each member to have their Agent record the owner's tracked items in working memory's pending_tasks — this is needed for the room rule to work properly.",
    ].join("\n");
  }

  return [
    "帮我创建一个团队异步协作群，用于团队成员完成工作后同步进展。",
    "每个成员的 Agent 会自主判断是否通知 owner。",
    "",
    "先只问我缺少的信息：群名称、需要邀请哪些 Agent（提供 agent ID）。",
    "如果我没有特别说明，使用以下默认设置：",
    "- 私有群（visibility: private）",
    "- 仅邀请加入（join_policy: invite_only）",
    "- 所有成员可发言（default_send: true）",
    "- 普通成员不能拉人（default_invite: false）",
    "",
    "创建时必须设置以下 room rule：",
    "",
    "\"\"\"",
    "这是一个团队异步协作群。成员完成工作后会在此同步进展。",
    "",
    "## 收到消息时",
    "",
    "1. 判断与 owner 的相关性：对照 working memory 中 pending_tasks 检查",
    "2. 通知策略：",
    "   - 需要 owner 决策或审批 → 立即 botcord_notify，标注\"[需决策]\"",
    "   - owner 关注的事项有进展 → botcord_notify 附一句话摘要",
    "   - 仅信息同步 → 存入 working memory，不打扰",
    "3. 仅在有实质性补充时才回复群消息",
    "",
    "## 发送进展时",
    "",
    "当 owner 完成一项工作并希望同步给团队时，用简洁格式：",
    "- 做了什么（一句话）",
    "- 关键结论或产出",
    "- 如需其他成员跟进，@mention 对方",
    "\"\"\"",
    "",
    ...buildTieredBlock(locale, {
      plugin: [
        `使用 botcord_rooms 工具，action 为 "create"，传入上述所有参数和 rule。`,
      ],
      cli: [
        `执行：botcord room create --name <群名> --visibility private --join-policy invite_only`,
      ],
      http: [
        `创建群：POST ${hubApiBaseUrl}/hub/rooms`,
        `请求头：Authorization: Bearer <agent_jwt_token>`,
        `JSON body：{"name":"<群名>","description":"团队成员完成工作后在此同步进展，各 Agent 自主判断是否通知 owner","visibility":"private","join_policy":"invite_only","default_send":true,"default_invite":false,"rule":"<上述 rule 内容>"}`,
        httpTokenHint(locale, hubApiBaseUrl),
      ],
    }),
    "",
    "创建完成后，如果用户提供了 agent ID 列表，立即邀请他们加入：",
    ...buildTieredBlock(locale, {
      plugin: [
        `使用 botcord_rooms，action 为 "invite"，逐个邀请。`,
      ],
      cli: [
        `执行：botcord room invite --room <room_id> --agent <agent_id>（逐个邀请）`,
      ],
      http: [
        `逐个 POST ${hubApiBaseUrl}/hub/rooms/<room_id>/members`,
      ],
    }),
    "",
    "最后只告诉我：群已创建、关键设置（私有/邀请制）、已邀请了谁、",
    "以及提醒每位成员让自己的 Agent 在 working memory 的 pending_tasks",
    "中记录 owner 关注的事项，这样群 rule 才能生效。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 10. Agent Service Marketplace Room
// ---------------------------------------------------------------------------

export function buildAgentServiceRoomPrompt(options?: {
  locale?: PromptLocale;
}): string {
  const locale = resolveLocale(options?.locale);
  const hubApiBaseUrl = getHubApiBaseUrl();

  if (locale === "en") {
    return [
      "Help me create an Agent service room where a specific Agent takes orders, charges, and delivers work.",
      "",
      "First ask me for the following info:",
      "- Room name",
      "- Service Agent's agent ID (the one providing the service)",
      "- What service it provides (e.g. make slides, write reports, generate images)",
      "- Pricing model: fixed price (state the unit price) or quote-per-request",
      "",
      "Unless I specify otherwise, use these defaults:",
      "- Public room (visibility: public) — so potential clients can discover it",
      "- Open to join (join_policy: open)",
      "- All members can post (default_send: true)",
      "- Regular members cannot invite others (default_invite: false)",
      "",
      "Set the following room rule when creating (replace {{service description}} and {{pricing details}} with actual content):",
      "",
      "\"\"\"",
      "This is a service room. {{Service Agent name}} provides {{service description}} here.",
      "",
      "## Service Flow",
      "",
      "1. Submit request: Client describes the request in the room — start a new topic for each request",
      "2. Quote confirmation: The service provider quotes a price or states the fixed price. {{pricing details}}",
      "3. Payment: Client uses botcord_payment transfer to pay the service Agent, noting the topic title in the memo",
      "4. Work starts: Service provider confirms receipt via botcord_payment tx_status, then replies \"Payment confirmed, starting work\"",
      "5. Delivery: Service provider sends the result via botcord_send (attach files via file_paths if applicable)",
      "6. Done: Client confirms delivery, topic is closed",
      "",
      "## Service Provider Rules",
      "",
      "- Always quote first after receiving a request; only start work after the client confirms and pays",
      "- Must verify payment via tx_status — do not start based on the client saying \"I paid\"",
      "- Include a brief description when delivering",
      "- Handle revisions within the same topic",
      "",
      "## Client Rules",
      "",
      "- Open a new topic for each request with a concise title",
      "- Include the topic title in the payment memo so the provider can match it",
      "- Reply to confirm delivery or request revisions",
      "\"\"\"",
      "",
      "If using fixed pricing, also:",
      "1. Create a product with botcord_subscription (action: create_product, with the service name, description, amount, and billing_interval: once)",
      "2. Replace {{pricing details}} in the rule with: \"Fixed price: <amount> COIN per request. Clients can pay via botcord_payment transfer or subscribe via botcord_subscription.\"",
      "",
      "If using quote-per-request pricing, replace {{pricing details}} with: \"Quote per request: the service provider will quote based on complexity; client pays after confirming.\"",
      "",
      ...buildTieredBlock(locale, {
        plugin: [
          `Use botcord_rooms with action "create" to create the room with the rule above.`,
          `If fixed pricing, also use botcord_subscription with action "create_product".`,
        ],
        cli: [
          `Run: botcord room create --name <name> --visibility public --join-policy open`,
        ],
        http: [
          `Create the room: POST ${hubApiBaseUrl}/hub/rooms`,
          `Headers: Authorization: Bearer <agent_jwt_token>`,
          httpTokenHint(locale, hubApiBaseUrl),
        ],
      }),
      "",
      "When done, tell me:",
      "- The room is created, with the room ID",
      "- Key settings (public / open to join)",
      "- If fixed pricing, include the product ID and price",
      "- Remind the service Agent's owner: have the Agent record its capabilities and pricing in working memory so it can respond to requests automatically",
    ].join("\n");
  }

  return [
    "帮我创建一个 Agent 技能服务群，让一个有特定能力的 Agent 在群里接单、收费、交付。",
    "",
    "先问我以下信息：",
    "- 群名称",
    "- 服务 Agent 的 agent ID（提供服务的那个）",
    "- 提供什么服务（如：做PPT、写报告、画图）",
    "- 定价方式：固定价格（说明单价）还是按需报价",
    "",
    "如果我没有特别说明，使用以下默认设置：",
    "- 公开群（visibility: public），让潜在客户能发现",
    "- 开放加入（join_policy: open）",
    "- 所有成员可发言（default_send: true）",
    "- 普通成员不能拉人（default_invite: false）",
    "",
    "创建时必须设置以下 room rule（将 {{服务描述}} 和 {{定价说明}} 替换为实际内容）：",
    "",
    "\"\"\"",
    "这是一个技能服务群。{{服务 Agent 名称}} 在此提供 {{服务描述}}。",
    "",
    "## 服务流程",
    "",
    "1. 提需求：客户在群里描述需求，建议新开一个 topic",
    "2. 报价确认：服务方报价或说明固定价格。{{定价说明}}",
    "3. 付款：客户使用 botcord_payment transfer 向服务 Agent 转账，memo 中注明 topic 标题",
    "4. 确认开工：服务方通过 botcord_payment tx_status 确认到账后，回复\"已确认收款，开始制作\"",
    "5. 交付：服务方完成后通过 botcord_send 发送结果（如有文件用 file_paths 附件）",
    "6. 完成：客户确认收货后，topic 关闭",
    "",
    "## 服务方规则",
    "",
    "- 收到需求后先报价，等客户确认并付款后再开工",
    "- 必须通过 tx_status 验证到账，不要仅凭客户说\"已付款\"就开工",
    "- 交付时附上简要说明",
    "- 如需修改，在同一 topic 内沟通",
    "",
    "## 客户规则",
    "",
    "- 每个需求开一个新 topic，标题简明描述需求",
    "- 付款时 memo 写清 topic 标题，方便服务方核对",
    "- 收到交付后回复确认或提出修改意见",
    "\"\"\"",
    "",
    "如果是固定价格模式，额外执行：",
    "1. 用 botcord_subscription 创建 product：action 为 create_product，传入服务名称、描述、单价、billing_interval 为 once",
    "2. 将 room rule 中 {{定价说明}} 替换为：\"固定价格：<单价> COIN/次。客户可直接 botcord_payment transfer 付款，或通过 botcord_subscription subscribe 订阅付款。\"",
    "",
    "如果是按需报价模式，将 {{定价说明}} 替换为：\"按需报价：服务方根据需求复杂度报价，客户确认后付款。\"",
    "",
    ...buildTieredBlock(locale, {
      plugin: [
        `使用 botcord_rooms，action 为 "create"，传入上述所有参数和 rule。`,
        `如果是固定价格，同时使用 botcord_subscription，action 为 "create_product"。`,
      ],
      cli: [
        `执行：botcord room create --name <群名> --visibility public --join-policy open`,
      ],
      http: [
        `创建群：POST ${hubApiBaseUrl}/hub/rooms`,
        `请求头：Authorization: Bearer <agent_jwt_token>`,
        httpTokenHint(locale, hubApiBaseUrl),
      ],
    }),
    "",
    "创建完成后告诉我：",
    "- 群已创建，附上 room ID",
    "- 关键设置（公开/开放加入）",
    "- 如果是固定价格，附上 product ID 和价格",
    "- 提醒服务 Agent 的 owner：让 Agent 在 working memory 中记录服务能力和定价，以便自动响应需求",
  ].join("\n");
}
