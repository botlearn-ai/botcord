"use client";

/**
 * [INPUT]: 依赖 betaApi (redeem/waitlist), Supabase auth session, URL query param ?code=
 * [OUTPUT]: /invite 页面 — 邀请码激活 + 等待列表申请
 * [POS]: 公测准入落地页，middleware 将未激活用户重定向至此
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import { Input } from "@/components/ui/Input";
import Button from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, KeyRound, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { betaApi, userApi } from "@/lib/api";
import { resolveInviteAccess, type InvitePageState } from "@/lib/invite-access";

export default function InvitePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  const [pageState, setPageState] = useState<InvitePageState>("loading");

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

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;

      const betaGateEnabled = process.env.NEXT_PUBLIC_BETA_GATE_ENABLED !== "false";

      if (!session) {
        setPageState("guest");
        return;
      }

      let profileBetaAccess = false;
      let profileEmail: string | null = null;

      try {
        const profile = await userApi.getMe({ force: true });
        if (cancelled) return;
        profileBetaAccess = profile.beta_access === true;
        profileEmail = profile.email;
      } catch {
        // 后端瞬时失败时退回 session 元数据，避免 invite 页彻底失明。
      }

      const decision = resolveInviteAccess({
        betaGateEnabled,
        hasSession: true,
        sessionBetaAccess: session.user.user_metadata?.beta_access === true,
        profileBetaAccess,
      });

      setPageState(decision.pageState);
      if (profileEmail || session.user.email) {
        setEmail(profileEmail || session.user.email || "");
      }

      if (decision.shouldRefreshSession) {
        await supabase.auth.refreshSession().catch(() => undefined);
        if (cancelled) return;
      }

      if (decision.shouldRedirectToChats) {
        router.replace("/chats/messages");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

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

  if (pageState === "loading" || pageState === "activated") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-deep-black">
        <Loader2 className="h-6 w-6 animate-spin text-neon-cyan" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-deep-black p-4">
      <div className="w-full max-w-lg space-y-4">
        {/* Header */}
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-neon-cyan/80">BotCord 公测</p>
          <h1 className="mt-3 text-3xl font-semibold text-text-primary">申请公测资格</h1>
          <p className="mt-2 text-sm text-text-secondary">
            {pageState === "guest" ? "登录后使用邀请码激活，或申请加入等待列表。" : "输入邀请码立即激活，或申请加入等待列表。"}
          </p>
        </div>

        {/* Invite code section */}
        <Card padding="lg" >
          <div className="flex items-center gap-2 text-text-primary">
            <KeyRound className="h-4 w-4 text-neon-cyan" />
            <span className="text-sm font-semibold">已有邀请码？</span>
          </div>
          <div className="mt-4 flex gap-2">
            <Input
              type="text"
              aria-label="邀请码"
              placeholder="输入邀请码，如 KOL-ABCD1234"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && handleRedeem()}
              disabled={codeLoading || codeSuccess || pageState === "guest"}
              className="flex-1"
            />
            <Button variant="primary"
              onClick={handleRedeem}
              disabled={codeLoading || !code.trim() || codeSuccess || pageState === "guest"} >
              {codeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "激活"}
            </Button>
          </div>
          {codeError && (
            <Alert tone="danger" className="mt-2">
              {codeError}
            </Alert>
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
        </Card>

        {/* Divider */}
        <div className="flex items-center gap-3 px-2">
          <div className="h-px flex-1 bg-glass-border" />
          <span className="text-xs text-text-secondary">没有邀请码？</span>
          <div className="h-px flex-1 bg-glass-border" />
        </div>

        {/* Waitlist section */}
        <Card padding="lg" >
          <div className="flex items-center gap-2 text-text-primary">
            <Mail className="h-4 w-4 text-neon-cyan" />
            <span className="text-sm font-semibold">申请公测资格</span>
          </div>
          {waitlistSuccess ? (
            <Card padding="md" className="mt-4">
              <p className="text-sm text-neon-cyan">申请已提交！审核通过后，邀请码将发送至你的邮箱。</p>
            </Card>
          ) : (
            <>
              <div className="mt-4 space-y-3">
                <Input
                  type="email"
                  aria-label="邮箱"
                  placeholder="你的邮箱"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={waitlistLoading || pageState === "guest"}
                />
                <Textarea
                  aria-label="使用场景（选填）"
                  placeholder="简单介绍你的使用场景（选填）"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  disabled={waitlistLoading || pageState === "guest"}
                  className="resize-none"
                />
              </div>
              {waitlistError && (
                <Alert tone="danger" className="mt-2">
                  {waitlistError}
                </Alert>
              )}
              <Button variant="secondary"
                onClick={handleWaitlist}
                disabled={waitlistLoading || !email.trim() || pageState === "guest"}
                className="mt-4 w-full" >
                {waitlistLoading ? (
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                ) : (
                  "提交申请"
                )}
              </Button>
              {pageState === "guest" && (
                <p className="mt-2 text-xs text-text-secondary">
                  请先{" "}
                  <a href="/login" className="text-neon-cyan underline">
                    登录
                  </a>{" "}
                  再提交申请。
                </p>
              )}
              <p className="mt-3 text-xs text-text-secondary">审核通过后，邀请码将发送至你的邮箱。</p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
