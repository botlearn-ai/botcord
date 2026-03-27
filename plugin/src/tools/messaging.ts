/**
 * botcord_send — Agent tool for sending messages via BotCord.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { lookup } from "node:dns";
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { attachTokenPersistence } from "../credentials.js";
import { getConfig as getAppConfig } from "../runtime.js";
import type { MessageAttachment } from "../types.js";

/** Extract clean filename from a URL, stripping query string and hash. */
function extractFilename(url: string): string {
  try {
    return new URL(url).pathname.split("/").pop() || "attachment";
  } catch {
    return url.split("/").pop()?.split("?")[0]?.split("#")[0] || "attachment";
  }
}

/** Guess MIME type from file extension. */
function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    txt: "text/plain",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    xml: "application/xml",
    pdf: "application/pdf",
    zip: "application/zip",
    gz: "application/gzip",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
    csv: "text/csv",
    md: "text/markdown",
  };
  return map[ext || ""] || "application/octet-stream";
}

/**
 * Upload local files to Hub and return attachments.
 */
async function uploadLocalFiles(
  client: BotCordClient,
  filePaths: string[],
): Promise<MessageAttachment[]> {
  const results: MessageAttachment[] = [];
  for (const filePath of filePaths) {
    const data = await readFile(filePath);
    const filename = basename(filePath);
    const contentType = guessMimeType(filename);
    const uploaded = await client.uploadFile(data, filename, contentType);
    results.push({
      filename: uploaded.original_filename,
      url: uploaded.url,
      content_type: uploaded.content_type,
      size_bytes: uploaded.size_bytes,
    });
  }
  return results;
}

export function createMessagingTool() {
  return {
    name: "botcord_send",
    label: "Send Message",
    description:
      "Send a message to another agent or room via BotCord. " +
      "Use ag_* for direct messages, rm_* for rooms. " +
      "Set type to 'result' or 'error' to terminate a topic. " +
      "Attach files via file_paths (local files, auto-uploaded) or file_urls (existing URLs).",
    parameters: {
      type: "object" as const,
      properties: {
        to: {
          type: "string" as const,
          description: "Target agent ID (ag_...) or room ID (rm_...)",
        },
        text: {
          type: "string" as const,
          description: "Message text to send",
        },
        topic: {
          type: "string" as const,
          description: "Topic name for the conversation",
        },
        goal: {
          type: "string" as const,
          description: "Goal of the conversation — declares why the topic exists",
        },
        type: {
          type: "string" as const,
          enum: ["message", "result", "error"],
          description: "Message type: 'message' (default), 'result' (task done), 'error' (task failed)",
        },
        reply_to: {
          type: "string" as const,
          description: "Message ID to reply to",
        },
        mentions: {
          type: "array" as const,
          items: { type: "string" as const },
          description: 'Agent IDs to mention (e.g. ["ag_xxx"]). Use ["@all"] to mention everyone.',
        },
        file_paths: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Local file paths to upload and attach to the message",
        },
        file_urls: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "URLs of already-hosted files to attach to the message",
        },
      },
      required: ["to", "text"],
    },
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
      const cfg = getAppConfig();
      if (!cfg) return { error: "No configuration available" };
      const singleAccountError = getSingleAccountModeError(cfg);
      if (singleAccountError) return { error: singleAccountError };

      const acct = resolveAccountConfig(cfg);
      if (!isAccountConfigured(acct)) {
        return { error: "BotCord is not configured. Set hubUrl, agentId, keyId, and privateKey." };
      }

      try {
        const client = new BotCordClient(acct);
        attachTokenPersistence(client, acct);
        const msgType = args.type || "message";

        // Collect attachments from both file_paths (upload first) and file_urls
        const attachments: MessageAttachment[] = [];

        // Upload local files
        if (args.file_paths && args.file_paths.length > 0) {
          const uploaded = await uploadLocalFiles(client, args.file_paths);
          attachments.push(...uploaded);
        }

        // Add pre-existing URL attachments
        if (args.file_urls && args.file_urls.length > 0) {
          for (const url of args.file_urls) {
            attachments.push({ filename: extractFilename(url), url });
          }
        }

        const finalAttachments = attachments.length > 0 ? attachments : undefined;

        if (msgType === "message") {
          const result = await client.sendMessage(args.to, args.text, {
            replyTo: args.reply_to,
            topic: args.topic,
            goal: args.goal,
            mentions: args.mentions,
            attachments: finalAttachments,
          });
          return { ok: true, hub_msg_id: result.hub_msg_id, to: args.to, attachments: finalAttachments };
        }

        // result/error types — use sendTypedMessage for topic termination
        const result = await client.sendTypedMessage(args.to, msgType, args.text, {
          replyTo: args.reply_to,
          topic: args.topic,
          attachments: finalAttachments,
        });
        return { ok: true, hub_msg_id: result.hub_msg_id, to: args.to, type: msgType, attachments: finalAttachments };
      } catch (err: any) {
        return { error: `Failed to send: ${err.message}` };
      }
    },
  };
}

/**
 * Standalone file upload tool — uploads files to Hub without sending a message.
 */
export function createUploadTool() {
  return {
    name: "botcord_upload",
    label: "Upload Files",
    description:
      "Upload one or more local files to BotCord Hub. " +
      "Returns file URLs that can be used later in botcord_send's file_urls parameter. " +
      "Files expire after the Hub's configured TTL (default 1 hour).",
    parameters: {
      type: "object" as const,
      properties: {
        file_paths: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Local file paths to upload",
        },
      },
      required: ["file_paths"],
    },
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
      const cfg = getAppConfig();
      if (!cfg) return { error: "No configuration available" };
      const singleAccountError = getSingleAccountModeError(cfg);
      if (singleAccountError) return { error: singleAccountError };

      const acct = resolveAccountConfig(cfg);
      if (!isAccountConfigured(acct)) {
        return { error: "BotCord is not configured. Set hubUrl, agentId, keyId, and privateKey." };
      }

      if (!args.file_paths || args.file_paths.length === 0) {
        return { error: "file_paths is required and must not be empty" };
      }

      try {
        const client = new BotCordClient(acct);
        attachTokenPersistence(client, acct);
        const uploaded = await uploadLocalFiles(client, args.file_paths);
        return { ok: true, files: uploaded };
      } catch (err: any) {
        return { error: `Upload failed: ${err.message}` };
      }
    },
  };
}
