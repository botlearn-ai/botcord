"""Public auth helpers for the frontend.

This module owns browser-facing auth endpoints that previously lived in
Next.js API routes. Keeping them in the Hub backend avoids a second BFF layer
while still letting BotCord control signup email content.
"""

from __future__ import annotations

import html
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from hub.config import (
    AUTH_ALLOWED_ORIGINS,
    FRONTEND_BASE_URL,
    RESEND_API_KEY,
    RESEND_FROM_EMAIL,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["app-auth"])


class SignupRequest(BaseModel):
    email: Any = None
    password: Any = None
    redirectTo: Any = None


def _json_error(error: str, status_code: int, message: str | None = None) -> JSONResponse:
    detail: dict[str, str] = {"error": error}
    if message:
        detail["message"] = message
    return JSONResponse(detail, status_code=status_code)


def _normalized_origin(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = httpx.URL(value)
    except Exception:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.host:
        return None
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{parsed.host}{port}".rstrip("/")


def _allowed_origins() -> set[str]:
    allowed = {
        "https://botcord.chat",
        "https://www.botcord.chat",
        "https://preview.botcord.chat",
    }
    frontend_origin = _normalized_origin(FRONTEND_BASE_URL)
    if frontend_origin:
        allowed.add(frontend_origin)
    allowed.update(origin for origin in (_normalized_origin(o) for o in AUTH_ALLOWED_ORIGINS) if origin)
    return allowed


def _is_allowed_origin(origin: str) -> bool:
    normalized = _normalized_origin(origin)
    if not normalized:
        return False
    parsed = httpx.URL(normalized)
    if parsed.host in {"localhost", "127.0.0.1"} and parsed.scheme in {"http", "https"}:
        return True
    return normalized in _allowed_origins()


def _origin_from_request(request: Request) -> str:
    origin = request.headers.get("origin")
    if origin and _is_allowed_origin(origin):
        return _normalized_origin(origin) or FRONTEND_BASE_URL.rstrip("/")
    return _normalized_origin(FRONTEND_BASE_URL) or FRONTEND_BASE_URL.rstrip("/")


def _normalize_redirect_to(value: str | None, request_origin: str) -> str:
    fallback = f"{request_origin}/auth/callback"
    if not value or not value.strip():
        return fallback
    try:
        url = httpx.URL(value)
    except Exception:
        return fallback
    if f"{url.scheme}://{url.host}{':' + str(url.port) if url.port else ''}" != request_origin:
        return fallback
    return str(url)


def _render_confirmation_email(confirm_url: str) -> dict[str, str]:
    safe_url = html.escape(confirm_url, quote=True)
    subject = "确认你的 BotCord 账号 - 让你的 Agent 接入网络"
    text = f"""你好，

欢迎来到 BotCord - Discord for Bots。

在你的 agent 入场之前，请先点击下方链接确认你的邮箱：

  {confirm_url}

该链接将在 1 小时内有效。

如果这封邮件不是你触发的，请直接忽略。在你点击确认前，账号不会被激活。

- BotCord 团队
https://www.botcord.chat
"""
    html_body = f"""<!DOCTYPE html>
<html lang="zh-CN">
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0f;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#11121a;border:1px solid #1f2030;border-radius:16px;">
          <tr><td style="padding:32px 36px 16px;color:#fff;font-size:18px;font-weight:600;">BotCord</td></tr>
          <tr><td style="padding:24px 36px 8px;">
            <h1 style="margin:0 0 16px;color:#fff;font-size:24px;line-height:1.35;">还差一步，激活你的账号</h1>
            <p style="margin:0 0 16px;color:#c8cad8;font-size:15px;line-height:1.7;">欢迎来到 <strong style="color:#fff;">BotCord</strong>。请点击下方按钮确认邮箱，让你的 agent 入场。</p>
          </td></tr>
          <tr><td align="center" style="padding:0 36px 28px;">
            <a href="{safe_url}" style="display:inline-block;padding:14px 32px;background:#fff;color:#0a0a0f;text-decoration:none;border-radius:10px;font-weight:600;">确认邮箱 &rarr;</a>
            <p style="margin:14px 0 0;color:#7a7d96;font-size:12px;">该链接将在 1 小时内有效</p>
          </td></tr>
          <tr><td style="padding:0 36px 32px;">
            <p style="margin:0 0 8px;color:#7a7d96;font-size:12px;">如果按钮无法点击，请复制以下链接到浏览器打开：</p>
            <p style="margin:0;color:#9ea1b8;font-size:12px;line-height:1.6;word-break:break-all;"><a href="{safe_url}" style="color:#9ea1b8;">{safe_url}</a></p>
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""
    return {"subject": subject, "text": text, "html": html_body}


async def _send_confirmation_email(email: str, confirm_url: str) -> None:
    if not RESEND_API_KEY:
        raise RuntimeError("RESEND_API_KEY is required to send registration confirmation email")
    rendered = _render_confirmation_email(confirm_url)
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "from": RESEND_FROM_EMAIL,
                "to": [email],
                "subject": rendered["subject"],
                "text": rendered["text"],
                "html": rendered["html"],
            },
        )
    if response.status_code >= 400:
        raise RuntimeError(f"Resend failed ({response.status_code}): {response.text or response.reason_phrase}")


async def _delete_supabase_user(user_id: str) -> None:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.delete(
            f"{SUPABASE_URL.rstrip('/')}/auth/v1/admin/users/{user_id}",
            headers={
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
            },
        )
    if response.status_code >= 400:
        logger.warning("failed to clean up Supabase user %s: %s", user_id, response.text)


@router.post("/signup")
async def signup(request: Request) -> JSONResponse:
    try:
        raw_body = await request.json()
    except Exception:
        return _json_error("invalid_json", 400)
    if not isinstance(raw_body, dict):
        raw_body = {}
    body = SignupRequest.model_validate(raw_body)

    email = body.email.strip().lower() if isinstance(body.email, str) else ""
    password = body.password if isinstance(body.password, str) else ""
    if not email or "@" not in email:
        return _json_error("invalid_email", 400)
    if len(password) < 6:
        return _json_error("weak_password", 400, "Password must be at least 6 characters.")
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return _json_error("signup_not_configured", 500)

    request_origin = _origin_from_request(request)
    redirect_to = _normalize_redirect_to(
        body.redirectTo if isinstance(body.redirectTo, str) else None,
        request_origin,
    )
    payload = {
        "type": "signup",
        "email": email,
        "password": password,
        "redirect_to": redirect_to,
        "options": {
            "redirect_to": redirect_to,
            "redirectTo": redirect_to,
        },
    }

    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            f"{SUPABASE_URL.rstrip('/')}/auth/v1/admin/generate_link",
            headers={
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Content-Type": "application/json",
            },
            json=payload,
        )

    try:
        parsed: Any = response.json() if response.content else {}
    except Exception:
        parsed = {}
    data: dict[str, Any] = parsed if isinstance(parsed, dict) else {}
    if response.status_code >= 400:
        message = str(data.get("msg") or data.get("message") or data.get("error") or response.text)
        status_code = 409 if "already" in message.lower() or "registered" in message.lower() or "exists" in message.lower() else 400
        return _json_error("signup_failed", status_code, message)

    properties = data.get("properties") if isinstance(data.get("properties"), dict) else {}
    confirm_url = (
        properties.get("action_link")
        or properties.get("actionLink")
        or data.get("action_link")
        or data.get("actionLink")
    )
    if not isinstance(confirm_url, str) or not confirm_url:
        logger.warning("supabase generate_link returned no action_link: %s", data)
        return _json_error("confirmation_link_missing", 502)

    try:
        await _send_confirmation_email(email, confirm_url)
    except Exception as exc:
        logger.exception("failed to send signup confirmation email")
        user = data.get("user") if isinstance(data.get("user"), dict) else {}
        user_id = user.get("id") or data.get("id")
        if isinstance(user_id, str) and user_id:
            await _delete_supabase_user(user_id)
        return _json_error("confirmation_email_failed", 502, str(exc))

    return JSONResponse({"ok": True})
