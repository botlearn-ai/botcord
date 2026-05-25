/**
 * [INPUT]: POST { botToken } from the Telegram gateway setup form
 * [OUTPUT]: Recent Telegram chats extracted by Hub /api/telegram/chat-ids
 * [POS]: thin migration shim; Telegram Bot API access lives in backend/app/routers/telegram.py
 * [PROTOCOL]: token is forwarded only to Hub and is never persisted here
 */

import { proxyHub } from "../../_lib/proxy-hub";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return proxyHub("/api/telegram/chat-ids", { method: "POST", body });
}
