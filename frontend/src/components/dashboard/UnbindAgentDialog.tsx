"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { userApi } from "@/lib/api";
import { animateOverlayPanelEnter, animateOverlayPanelExit, animatePop, cleanupAnime } from "@/lib/anime";
import { useLanguage } from "@/lib/i18n";
import { unbindAgentDialog } from "@/lib/i18n/translations/dashboard";
import { AlertTriangle, Loader2, Unlink, X } from "lucide-react";

interface UnbindAgentDialogProps {
  agentId: string;
  agentName: string;
  deleteMode?: "unbind" | "cloud";
  onClose: () => void;
  onUnbound: (agentId: string) => Promise<void> | void;
}

export default function UnbindAgentDialog({
  agentId,
  agentName,
  deleteMode = "unbind",
  onClose,
  onUnbound,
}: UnbindAgentDialogProps) {
  const locale = useLanguage();
  const t = unbindAgentDialog[locale];
  const isCloudDelete = deleteMode === "cloud";
  const copy = isCloudDelete
    ? {
        title: locale === "zh" ? "删除云端 Bot" : "Delete Cloud Bot",
        description: locale === "zh"
          ? "这将删除云端 Bot，并清理对应的云端运行环境、凭据与未结算用量预留。"
          : "This will delete the Cloud Bot and clean up its cloud runtime, credentials, and pending usage reservations.",
        warning: locale === "zh"
          ? "此操作不可撤销。删除后如果需要使用该 Bot，需要重新创建。"
          : "This action cannot be undone. Create a new Bot if you need it again.",
        targetAgent: locale === "zh" ? "即将删除：" : "Bot to delete: ",
        confirm: locale === "zh" ? "确认删除" : "Confirm Delete",
        loading: locale === "zh" ? "删除中..." : "Deleting...",
        failed: locale === "zh" ? "删除云端 Bot 失败" : "Failed to delete Cloud Bot",
      }
    : {
        title: t.title,
        description: t.description,
        warning: t.warning,
        targetAgent: t.targetAgent,
        confirm: t.confirm,
        loading: t.unbinding,
        failed: t.failed,
      };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const errorAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

  async function handleUnbind() {
    setLoading(true);
    setError(null);
    try {
      if (isCloudDelete) {
        await userApi.deleteCloudAgent(agentId);
      } else {
        await userApi.unbindAgent(agentId);
      }
      await onUnbound(agentId);
      closeWithMotion();
    } catch (err: any) {
      setError(err?.message || copy.failed);
      setLoading(false);
    }
  }

  const closeWithMotion = useCallback(() => {
    if (loading || closing) return;
    setClosing(true);
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      onComplete: onClose,
    });
  }, [closing, loading, onClose]);

  useEffect(() => {
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current);
    return () => cleanupAnime(animationRef.current);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeWithMotion();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeWithMotion]);

  useEffect(() => {
    if (!error || !errorRef.current) return;
    cleanupAnime(errorAnimationRef.current);
    errorAnimationRef.current = animatePop(errorRef.current);
    return () => cleanupAnime(errorAnimationRef.current);
  }, [error]);

  return (
    <div ref={overlayRef} className={`fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm ${closing ? "pointer-events-none" : ""}`} onMouseDown={(event) => { if (event.target === event.currentTarget) closeWithMotion(); }}>
      <div ref={panelRef} className="relative w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl">
        <button
          onClick={closeWithMotion}
          disabled={loading}
          className="absolute right-4 top-4 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mb-5 pr-8">
          <h3 className="flex items-center gap-2 text-xl font-bold text-text-primary">
            <Unlink className="h-5 w-5 text-red-400" />
            {copy.title}
          </h3>
          <p className="mt-2 text-sm text-text-secondary">{copy.description}</p>
        </div>

        <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
            <p className="text-xs text-amber-300">{copy.warning}</p>
          </div>
        </div>

        <p className="mt-4 text-xs text-text-secondary">
          {copy.targetAgent}
          <span className="font-mono text-text-primary">{agentName}</span>
          <span className="ml-1 text-text-secondary/50">({agentId})</span>
        </p>

        {error && (
          <p ref={errorRef} className="mt-4 rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-400">
            {error}
          </p>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={closeWithMotion}
            disabled={loading}
            className="rounded-xl border border-glass-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
          >
            {t.cancel}
          </button>
          <button
            onClick={handleUnbind}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl border border-red-400/50 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-400 transition-all hover:bg-red-500/20 disabled:opacity-60"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {copy.loading}
              </>
            ) : (
              copy.confirm
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
