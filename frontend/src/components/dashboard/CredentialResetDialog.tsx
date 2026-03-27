"use client";

/**
 * [INPUT]: 依赖 userApi 签发 reset_code，依赖 onboarding prompt 模板生成给 OpenClaw 的重置指令
 * [OUTPUT]: 对外提供 CredentialResetDialog，负责在 chats 左下角发起 Bot credential 重置流程
 * [POS]: dashboard 账户菜单的 credential 恢复入口，收敛 reset_code 签发与 Prompt 复制交互
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useState } from "react";
import { userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { credentialResetDialog } from "@/lib/i18n/translations/dashboard";
import { buildResetCredentialPrompt, getHubApiBaseUrl } from "@/lib/onboarding";
import { Check, Copy, Loader2, X } from "lucide-react";

interface CredentialResetDialogProps {
  agentId: string;
  onClose: () => void;
}

export default function CredentialResetDialog({
  agentId,
  onClose,
}: CredentialResetDialogProps) {
  const locale = useLanguage();
  const t = credentialResetDialog[locale];
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetCode, setResetCode] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    userApi.issueCredentialResetTicket(agentId)
      .then((resp) => {
        if (!mounted) return;
        setResetCode(resp.reset_code);
        setExpiresAt(resp.expires_at);
        setLoading(false);
      })
      .catch((err: any) => {
        if (!mounted) return;
        setError(err?.message || t.issueResetTicketFailed);
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [agentId, t.issueResetTicketFailed]);

  const promptText = useMemo(() => {
    if (!resetCode) return "";
    return buildResetCredentialPrompt({
      agentId,
      resetCode,
      hubUrl: getHubApiBaseUrl(),
      locale,
    });
  }, [agentId, locale, resetCode]);

  async function handleCopyPrompt() {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError(t.copyPromptFailed);
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-xl rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mb-6 pr-8">
          <h3 className="text-xl font-bold text-text-primary">{t.title}</h3>
          <p className="mt-1 text-sm text-text-secondary">{t.description}</p>
          <p className="mt-3 text-xs text-text-secondary/70">
            {t.targetAgent}{agentId}
          </p>
        </div>

        <div className="rounded-xl border border-glass-border bg-deep-black p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-widest text-text-secondary opacity-60">
              {t.prompt}
            </p>
            <button
              onClick={handleCopyPrompt}
              disabled={!promptText}
              className="flex items-center gap-2 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-semibold text-neon-cyan transition-all hover:bg-neon-cyan/20 disabled:opacity-60"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  {t.copied}
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  {t.copyPrompt}
                </>
              )}
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center rounded-lg border border-glass-border bg-deep-black-light p-6 text-neon-cyan">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <textarea
              readOnly
              value={promptText}
              rows={9}
              className="w-full resize-none rounded-lg border border-glass-border bg-deep-black-light p-3 font-mono text-[11px] leading-relaxed text-text-primary outline-none"
            />
          )}

          {expiresAt && (
            <p className="mt-2 text-[10px] text-text-secondary/50">
              {t.ticketExpiresAt}{new Date(expiresAt * 1000).toLocaleString()}
            </p>
          )}
        </div>

        {error ? (
          <p className="mt-4 rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-400">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex items-center justify-center">
          <button
            onClick={onClose}
            className="min-h-11 rounded-xl border border-neon-cyan/50 bg-neon-cyan px-5 py-3 text-sm font-bold text-black transition-all hover:bg-neon-cyan/90"
          >
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}
