/**
 * [INPUT]: JSON { email, password, redirectTo? }
 * [OUTPUT]: POST /api/auth/signup - creates a Supabase signup link and sends BotCord confirmation email
 * [POS]: BFF endpoint for email/password registration so BotCord controls the confirmation email design
 * [PROTOCOL]: update header on changes
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { renderRegistrationConfirmationEmail } from "@/lib/email/registration-confirmation";

type SignupRequest = {
  email?: unknown;
  password?: unknown;
  redirectTo?: unknown;
};

type GenerateLinkProperties = {
  action_link?: string;
  actionLink?: string;
};

function jsonError(error: string, status: number, message?: string) {
  return NextResponse.json({ error, message }, { status });
}

function normalizeRedirectTo(value: unknown, requestOrigin: string): string {
  const fallback = `${requestOrigin}/auth/callback`;
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  try {
    const url = new URL(value);
    if (url.origin !== requestOrigin) {
      return fallback;
    }
    return url.toString();
  } catch {
    return fallback;
  }
}

async function sendConfirmationEmail(email: string, confirmUrl: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is required to send registration confirmation email");
  }

  const rendered = renderRegistrationConfirmationEmail(confirmUrl);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || "BotCord <noreply@botcord.chat>",
      to: [email],
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend failed (${response.status}): ${body || response.statusText}`);
  }
}

export async function POST(req: Request) {
  let body: SignupRequest;
  try {
    body = (await req.json()) as SignupRequest;
  } catch {
    return jsonError("invalid_json", 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !email.includes("@")) {
    return jsonError("invalid_email", 400);
  }
  if (password.length < 6) {
    return jsonError("weak_password", 400, "Password must be at least 6 characters.");
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonError("signup_not_configured", 500);
  }

  const { origin } = new URL(req.url);
  const redirectTo = normalizeRedirectTo(body.redirectTo, origin);
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "signup",
    email,
    password,
    options: {
      redirectTo,
    },
  });

  if (error) {
    const status = /already|registered|exists/i.test(error.message) ? 409 : 400;
    return jsonError("signup_failed", status, error.message);
  }

  const properties = data.properties as GenerateLinkProperties | undefined;
  const confirmUrl = properties?.action_link || properties?.actionLink;
  if (!confirmUrl) {
    return jsonError("confirmation_link_missing", 502);
  }

  try {
    await sendConfirmationEmail(email, confirmUrl);
  } catch (err) {
    console.error("[api/auth/signup] failed to send confirmation email:", err);
    const userId = data.user?.id;
    if (userId) {
      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (deleteError) {
        console.error(
          "[api/auth/signup] failed to clean up user after email send failure:",
          deleteError.message,
        );
      }
    }
    return jsonError(
      "confirmation_email_failed",
      502,
      err instanceof Error ? err.message : String(err),
    );
  }

  return NextResponse.json({ ok: true });
}
