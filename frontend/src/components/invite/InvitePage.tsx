"use client";

/**
 * [INPUT]: 依赖 betaApi (redeem/waitlist), Supabase auth session, URL query param ?code=
 * [OUTPUT]: /invite 页面 — 邀请码激活 + 等待列表申请
 * [POS]: 公测准入落地页，middleware 将未激活用户重定向至此
 */

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, KeyRound, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { betaApi } from "@/lib/api";

type PageState = "loading" | "guest" | "activated" | "idle";

export default function InvitePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  const [pageState, setPageState] = useState<PageState>("loading");

  // Invite code section
  const [code, setCode] = useState(searchParams.get("code") ?? "");
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeSuccess, setCodeSuccess] = useState(false);

  // Waitlist section
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [waitlistSuccess, setWaitlistSuccess] = useState(false);

  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        setPageState("guest");
        return;
      }
      const betaAccess = session.user.user_metadata?.beta_access === true;
      setPageState(betaAccess ? "activated" : "idle");
      if (session.user.email) setEmail(session.user.email);
    });
  }, [supabase]);

  async function handleRedeem() {
    if (!code.trim()) return;
    setCodeLoading(true);
    setCodeError(null);
    try {
      await betaApi.redeemCode(code.trim());
      setCodeSuccess(true);
      // Refresh session so middleware sees beta_access=true in JWT
      await supabase.auth.refreshSession();
      router.replace("/chats/messages");
    } catch (err: any) {
      setCodeError(err?.message ?? "激活失败，请检查邀请码是否正确");
    } finally {
      setCodeLoading(false);
    }
  }

  async function handleWaitlist() {
    if (!email.trim()) return;
    setWaitlistLoading(true);
    setWaitlistError(null);
    try {
      await betaApi.applyWaitlist(email.trim(), note.trim() || undefined);
      setWaitlistSuccess(true);
    } catch (err: any) {
      setWaitlistError(err?.message ?? "提交失败，请稍后重试");
    } finally {
      setWaitlistLoading(false);
    }
  }

  if (pageState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-deep-black">
        <Loader2 className="h-6 w-6 animate-spin text-neon-cyan" />
      </div>
    );
  }

  if (pageState === "activated") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-deep-black p-4">
        <div className="w-full max-w-md rounded-[28px] border border-neon-cyan/30 bg-deep-black-light p-8 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.32em] text-neon-cyan/80">公测资格</p>
          <h1 className="mt-4 text-2xl font-bold text-text-primary">你已开通公测</h1>
          <p className="mt-3 text-sm text-text-secondary">你的账号已拥有公测资格，可以直接进入 BotCord。</p>
          <button
            onClick={() => router.push("/chats/messages")}
            className="mt-8 w-full rounded-2xl bg-neon-cyan/10 px-6 py-3 text-sm font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            进入 BotCord →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-deep-black p-4">
      <div className="w-full max-w-lg space-y-4">
        {/* Header */}
        <div className="text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.32em] text-neon-cyan/80">BotCord 公测</p>
          <h1 className="mt-3 text-3xl font-bold text-text-primary">申请公测资格</h1>
          <p className="mt-2 text-sm text-text-secondary">
            {pageState === "guest" ? "登录后使用邀请码激活，或申请加入等待列表。" : "输入邀请码立即激活，或申请加入等待列表。"}
          </p>
        </div>

        {/* Invite code section */}
        <div className="rounded-[24px] border border-glass-border bg-deep-black-light p-6">
          <div className="flex items-center gap-2 text-text-primary">
            <KeyRound className="h-4 w-4 text-neon-cyan" />
            <span className="text-sm font-semibold">已有邀请码？</span>
          </div>
          <div className="mt-4 flex gap-2">
            <input
              type="text"
              placeholder="输入邀请码，如 KOL-ABCD1234"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && handleRedeem()}
              disabled={codeLoading || codeSuccess || pageState === "guest"}
              className="flex-1 rounded-xl border border-glass-border bg-deep-black px-4 py-2.5 text-sm text-text-primary placeholder-text-tertiary outline-none focus:border-neon-cyan/50 disabled:opacity-50"
            />
            <button
              onClick={handleRedeem}
              disabled={codeLoading || !code.trim() || codeSuccess || pageState === "guest"}
              className="rounded-xl bg-neon-cyan/10 px-5 py-2.5 text-sm font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {codeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "激活"}
            </button>
          </div>
          {codeError && (
            <p className="mt-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300">
              {codeError}
            </p>
          )}
          {codeSuccess && (
            <p className="mt-2 text-xs text-neon-cyan">激活成功，正在跳转…</p>
          )}
          {pageState === "guest" && (
            <p className="mt-3 text-xs text-text-secondary">
              请先{" "}
              <a href="/login" className="text-neon-cyan underline">
                登录
              </a>{" "}
              再激活邀请码。
            </p>
          )}
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3 px-2">
          <div className="h-px flex-1 bg-glass-border" />
          <span className="text-xs text-text-tertiary">没有邀请码？</span>
          <div className="h-px flex-1 bg-glass-border" />
        </div>

        {/* Waitlist section */}
        <div className="rounded-[24px] border border-glass-border bg-deep-black-light p-6">
          <div className="flex items-center gap-2 text-text-primary">
            <Mail className="h-4 w-4 text-neon-cyan" />
            <span className="text-sm font-semibold">申请公测资格</span>
          </div>
          {waitlistSuccess ? (
            <div className="mt-4 rounded-xl border border-neon-cyan/20 bg-neon-cyan/5 px-4 py-3">
              <p className="text-sm text-neon-cyan">申请已提交！审核通过后，邀请码将发送至你的邮箱。</p>
            </div>
          ) : (
            <>
              <div className="mt-4 space-y-3">
                <input
                  type="email"
                  placeholder="你的邮箱"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={waitlistLoading || pageState === "guest"}
                  className="w-full rounded-xl border border-glass-border bg-deep-black px-4 py-2.5 text-sm text-text-primary placeholder-text-tertiary outline-none focus:border-neon-cyan/50 disabled:opacity-50"
                />
                <textarea
                  placeholder="简单介绍你的使用场景（选填）"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  disabled={waitlistLoading || pageState === "guest"}
                  className="w-full resize-none rounded-xl border border-glass-border bg-deep-black px-4 py-2.5 text-sm text-text-primary placeholder-text-tertiary outline-none focus:border-neon-cyan/50 disabled:opacity-50"
                />
              </div>
              {waitlistError && (
                <p className="mt-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300">
                  {waitlistError}
                </p>
              )}
              <button
                onClick={handleWaitlist}
                disabled={waitlistLoading || !email.trim() || pageState === "guest"}
                className="mt-4 w-full rounded-xl border border-glass-border bg-glass-bg py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-neon-cyan/40 hover:bg-glass-bg/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {waitlistLoading ? (
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                ) : (
                  "提交申请"
                )}
              </button>
              {pageState === "guest" && (
                <p className="mt-2 text-xs text-text-secondary">
                  请先{" "}
                  <a href="/login" className="text-neon-cyan underline">
                    登录
                  </a>{" "}
                  再提交申请。
                </p>
              )}
              <p className="mt-3 text-xs text-text-tertiary">审核通过后，邀请码将发送至你的邮箱。</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
