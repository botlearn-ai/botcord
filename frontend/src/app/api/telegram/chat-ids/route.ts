/**
 * [INPUT]: POST { botToken } from the Telegram gateway setup form
 * [OUTPUT]: Recent Telegram chats extracted from getUpdates
 * [POS]: BFF helper for discovering allowedChatIds without asking users to
 *        manually call Telegram Bot API
 * [PROTOCOL]: token is used only for this request and is never persisted here
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface TelegramChat {
  id?: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramSender {
  id?: number | string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessageLike {
  chat?: TelegramChat;
  from?: TelegramSender;
}

interface TelegramUpdate {
  message?: TelegramMessageLike;
  edited_message?: TelegramMessageLike;
  channel_post?: TelegramMessageLike;
  edited_channel_post?: TelegramMessageLike;
}

interface TelegramGetUpdatesResponse {
  ok?: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

function chatLabel(chat: TelegramChat): string {
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  const username = chat.username ? `@${chat.username}` : "";
  if (chat.title && username) return `${chat.title} ${username}`;
  return chat.title || username || name || String(chat.id ?? "");
}

function senderLabel(sender: TelegramSender): string {
  const name = [sender.first_name, sender.last_name].filter(Boolean).join(" ");
  const username = sender.username ? `@${sender.username}` : "";
  return username || name || String(sender.id ?? "");
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const botToken =
    typeof body === "object" &&
    body !== null &&
    "botToken" in body &&
    typeof body.botToken === "string"
      ? body.botToken.trim()
      : "";
  if (!botToken) {
    return NextResponse.json({ error: "missing_bot_token" }, { status: 400 });
  }
  const timeoutSeconds =
    typeof body === "object" &&
    body !== null &&
    "timeoutSeconds" in body &&
    typeof body.timeoutSeconds === "number"
      ? Math.min(Math.max(Math.floor(body.timeoutSeconds), 0), 10)
      : 0;

  let res: Response;
  try {
    const url = new URL(
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getUpdates`,
    );
    if (timeoutSeconds > 0) {
      url.searchParams.set("timeout", String(timeoutSeconds));
    }
    res = await fetch(
      url,
      { method: "POST", cache: "no-store" },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: "telegram_unreachable",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  const json = (await res.json().catch(() => ({}))) as TelegramGetUpdatesResponse;
  if (!res.ok || json.ok === false) {
    return NextResponse.json(
      {
        error: "telegram_get_updates_failed",
        message: json.description || `Telegram HTTP ${res.status}`,
      },
      { status: 400 },
    );
  }

  const byId = new Map<
    string,
    { id: string; type: string | null; label: string | null }
  >();
  const sendersById = new Map<string, { id: string; label: string | null }>();
  for (const update of json.result ?? []) {
    const message =
      update.message ??
      update.edited_message ??
      update.channel_post ??
      update.edited_channel_post;
    const chat = message?.chat;
    if (chat?.id === undefined || chat.id === null) continue;
    const id = String(chat.id);
    byId.set(id, {
      id,
      type: chat.type ?? null,
      label: chatLabel(chat) || null,
    });
    const sender = message?.from;
    if (sender?.id !== undefined && sender.id !== null) {
      const senderId = String(sender.id);
      sendersById.set(senderId, {
        id: senderId,
        label: senderLabel(sender) || null,
      });
    }
  }

  return NextResponse.json({
    chats: Array.from(byId.values()),
    senders: Array.from(sendersById.values()),
  });
}
