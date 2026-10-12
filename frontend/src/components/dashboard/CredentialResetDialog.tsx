"use client";
import Alert from "@/components/ui/Alert";
import Card from "@/components/ui/Card";

import { Textarea } from "@/components/ui/Input";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
/**
 * [INPUT]: 依赖 userApi 签发 reset_code，依赖 onboarding prompt 模板生成给 OpenClaw 的重置指令
 * [OUTPUT]: 对外提供 CredentialResetDialog，负责在 chats 左下角发起 Bot credential 重置流程
 * [POS]: dashboard 账户菜单的 credential 恢复入口，收敛 reset_code 签发与 Prompt 复制交互
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { userApi } from "@/lib/api";
import { animatePop, cleanupAnime } from "@/lib/anime";
import Button from "@/components/ui/Button";
import DialogShell from "@/components/ui/DialogShell";
import { useLanguage } from "@/lib/i18n";
import { credentialResetDialog } from "@/lib/i18n/translations/dashboard";
import { buildResetCredentialPrompt, getHubApiBaseUrl } from "@/lib/onboarding";
import { Check, Copy, Loader2 } from "lucide-react";

interface CredentialResetDialogProps {
  agentId: string;
  onClose: () => void;
}

export default withDashboardOverlayPortal(CredentialResetDialog);

function CredentialResetDialog({
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
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const feedbackAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

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

  useEffect(() => {
    const target = copied ? copyButtonRef.current : error ? errorRef.current : null;
    if (!target) return;
    cleanupAnime(feedbackAnimationRef.current);
    feedbackAnimationRef.current = animatePop(target);
    return () => cleanupAnime(feedbackAnimationRef.current);
  }, [copied, error]);

  return (
    <DialogShell
      title={t.title}
      description={t.description}
      onClose={onClose}
      className="max-w-xl"
      footer={(close) => (
        <Button variant="primary" onClick={close}>
          {t.close}
        </Button>
      )}
    >
      <p className="mb-4 text-xs text-text-secondary">
        {t.targetAgent}{agentId}
      </p>

      <Card padding="none" className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-semibold text-text-secondary opacity-60">
            {t.prompt}
          </p>
          <Button
            ref={copyButtonRef}
            variant="secondary"
            size="sm"
            onClick={handleCopyPrompt}
            disabled={!promptText}
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
          </Button>
        </div>

        {loading ? (
          <div className="liquid-tool-surface flex items-center justify-center rounded-lg p-6 text-accent-text">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <Textarea
            readOnly
            value={promptText}
            rows={9}
            className="w-full"
          />
        )}

        {expiresAt && (
          <p className="mt-2 text-xs text-text-secondary">
            {t.ticketExpiresAt}{new Date(expiresAt * 1000).toLocaleString()}
          </p>
        )}
      </Card>

      {error ? (
        <Alert tone="danger" ref={errorRef} className="mt-4">
          {error}
        </Alert>
      ) : null}
    </DialogShell>
  );
}
