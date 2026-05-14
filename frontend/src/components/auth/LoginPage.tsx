/**
 * [INPUT]: 依赖 Supabase client 完成邮箱认证，依赖 next/navigation 读取 next 参数，依赖 nextjs-toploader/app 提供登录后的带进度反馈跳转
 * [OUTPUT]: 对外提供 LoginPage 组件，承载登录/注册表单与认证状态反馈
 * [POS]: /login 页面主体，连接 Supabase 会话建立与 dashboard 落地跳转
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSearchParams } from "next/navigation";
import { useRouter } from "nextjs-toploader/app";
import { useLanguage } from '@/lib/i18n';
import { loginPage } from '@/lib/i18n/translations/auth';
import { common } from '@/lib/i18n/translations/common';

export default function LoginPage() {
  const locale = useLanguage();
  const t = loginPage[locale];
  const tc = common[locale];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/chats/home";
  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!cancelled && session) {
        router.replace(nextPath);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nextPath, router, supabase]);

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");
    const normalizedEmail = email.trim();

    if (mode === "login") {
      const { error } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });
      if (error) {
        setError(error.message);
      } else {
        router.push(nextPath);
      }
    } else {
      const { error } = await supabase.auth.signUp({
        email: normalizedEmail,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
        },
      });
      if (error) {
        setError(error.message);
      } else {
        setMessage(t.checkEmail.replace("{email}", normalizedEmail));
      }
    }
    setLoading(false);
  };

  const handleOAuthLogin = async (provider: "github" | "google") => {
    setError("");
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
      },
    });
    if (error) {
      setError(error.message);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-deep-black px-4">
      <div className="w-full max-w-md rounded-2xl border border-glass-border bg-glass-bg p-8 backdrop-blur-xl">
        <div className="mb-6 text-center">
          <h1 className="mb-2 text-2xl font-semibold text-text-primary">
            <span className="text-neon-cyan">BotCord</span>
          </h1>
          <p className="text-sm text-text-secondary">
            {mode === "login" ? t.signInToAccount : t.createAccount}
          </p>
        </div>

        {/* OAuth buttons */}
        <div className="mb-6 space-y-3">
          <button
            onClick={() => handleOAuthLogin("google")}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-glass-border bg-deep-black-light py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-glass-border/30"
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            {t.continueWithGoogle}
          </button>
          <button
            onClick={() => handleOAuthLogin("github")}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-glass-border bg-deep-black-light py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-glass-border/30"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            {t.continueWithGithub}
          </button>
        </div>

        <div className="mb-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-glass-border" />
          <span className="text-xs text-text-secondary">{tc.or}</span>
          <div className="h-px flex-1 bg-glass-border" />
        </div>

        {/* Email/password form */}
        <form onSubmit={handleEmailAuth} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-xs font-medium text-text-secondary">
              {t.email}
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-cyan/50"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-xs font-medium text-text-secondary">
              {t.password}
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-cyan/50"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {message && <p className="text-sm text-green-400">{message}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 py-2.5 font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-50"
          >
            {loading ? tc.loading : mode === "login" ? t.signIn : t.signUp}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-text-secondary">
          {mode === "login" ? (
            <>
              {t.dontHaveAccount}{" "}
              <button onClick={() => { setMode("signup"); setError(""); setMessage(""); }} className="text-neon-cyan hover:underline">
                {t.signUpLink}
              </button>
            </>
          ) : (
            <>
              {t.alreadyHaveAccount}{" "}
              <button onClick={() => { setMode("login"); setError(""); setMessage(""); }} className="text-neon-cyan hover:underline">
                {t.signInLink}
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
