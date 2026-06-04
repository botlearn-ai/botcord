import { createHash } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { sanitizeSenderName, sanitizeUntrustedContent } from "./gateway/channels/sanitize.js";
import type { GatewayInboundMessage, RuntimeSystemRule } from "./gateway/types.js";

const MANAGED_RULES_START = "<!-- BOTCORD_SYSTEM_RULES_START -->";
const MANAGED_RULES_END = "<!-- BOTCORD_SYSTEM_RULES_END -->";

interface RoomRuleRaw {
  room_id?: unknown;
  room_name?: unknown;
  room_rule?: unknown;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function buildRoomSystemRules(message: GatewayInboundMessage): RuntimeSystemRule[] {
  if (message.conversation.kind !== "group") return [];
  const raw = message.raw && typeof message.raw === "object" ? (message.raw as RoomRuleRaw) : {};
  const text = typeof raw.room_rule === "string" ? raw.room_rule.trim() : "";
  if (!text) return [];

  const roomId =
    typeof raw.room_id === "string" && raw.room_id ? raw.room_id : message.conversation.id;
  const roomName =
    typeof raw.room_name === "string" && raw.room_name
      ? raw.room_name
      : typeof message.conversation.title === "string"
        ? message.conversation.title
        : undefined;

  return [
    {
      kind: "room_rule",
      scope: "room",
      id: `room:${roomId}`,
      version: `sha256:${sha256(text)}`,
      roomId,
      ...(roomName ? { roomName } : {}),
      text,
    },
  ];
}

export function renderSystemRules(rules: RuntimeSystemRule[] | undefined): string | null {
  if (!rules || rules.length === 0) return null;
  const blocks = rules.map((rule) => {
    if (rule.kind === "room_rule") {
      const fields = [
        `id: ${sanitizeSenderName(rule.roomId)}`,
        `version: ${sanitizeSenderName(rule.version)}`,
      ];
      if (rule.roomName) fields.push(`name: ${sanitizeSenderName(rule.roomName)}`);
      return [
        "[BotCord Room Rule]",
        fields.join(" | "),
        sanitizeUntrustedContent(rule.text.trim()),
      ].join("\n");
    }
    return null;
  });
  const filtered = blocks.filter((b): b is string => typeof b === "string" && b.length > 0);
  return filtered.length > 0 ? filtered.join("\n\n") : null;
}

export function prependSystemRules(
  systemContext: string | undefined,
  rules: RuntimeSystemRule[] | undefined,
): string | undefined {
  const ruleBlock = renderSystemRules(rules);
  const parts = [ruleBlock, systemContext].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function managedSystemRulesSection(
  rules: RuntimeSystemRule[] | undefined,
): string | null {
  const rendered = renderSystemRules(rules);
  if (!rendered) return null;
  return [
    MANAGED_RULES_START,
    "This section is managed by BotCord daemon. Do not edit it manually.",
    "",
    rendered,
    MANAGED_RULES_END,
  ].join("\n");
}

export function replaceManagedSystemRulesSection(
  existing: string,
  rules: RuntimeSystemRule[] | undefined,
): string {
  const section = managedSystemRulesSection(rules);
  const start = existing.indexOf(MANAGED_RULES_START);
  const end = existing.indexOf(MANAGED_RULES_END);
  if (start >= 0 && end >= start) {
    const afterEnd = end + MANAGED_RULES_END.length;
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(afterEnd).trimStart();
    const parts = [before, section, after].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    return parts.length > 0 ? `${parts.join("\n\n")}\n` : "";
  }
  if (!section) return existing;
  const trimmed = existing.trimEnd();
  return trimmed ? `${trimmed}\n\n${section}\n` : `${section}\n`;
}

export function writeManagedSystemRulesFile(
  filePath: string,
  rules: RuntimeSystemRule[] | undefined,
  opts: { mergeWithExisting?: boolean } = {},
): void {
  const existing =
    opts.mergeWithExisting
      ? (() => {
          try {
            return readFileSync(filePath, "utf8");
          } catch {
            return "";
          }
        })()
      : "";
  const next = opts.mergeWithExisting
    ? replaceManagedSystemRulesSection(existing, rules)
    : `${managedSystemRulesSection(rules) ?? ""}\n`;
  if (existing === next) return;
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, filePath);
}
