"use client";
import Alert from "@/components/ui/Alert";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import { useState } from "react";
import { userApi } from "@/lib/api";
import Button from "@/components/ui/Button";
import DialogShell, { useDialogClose } from "@/components/ui/DialogShell";
import { useLanguage } from "@/lib/i18n";
import { unbindAgentDialog } from "@/lib/i18n/translations/dashboard";
import { AlertTriangle, Unlink } from "lucide-react";

interface UnbindAgentDialogProps {
  agentId: string;
  agentName: string;
  deleteMode?: "unbind" | "cloud";
  onClose: () => void;
  onUnbound: (agentId: string) => Promise<void> | void;
}

export default withDashboardOverlayPortal(UnbindAgentDialog, "nested");

function UnbindAgentDialog({
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
        title: locale === "zh" ? "删除云端 Agent" : "Delete Cloud Bot",
        description: locale === "zh"
          ? "将删除云端 Agent。清理其云端运行环境和登录凭据。清理未结算用量预留。"
          : "This will delete the Cloud Bot and clean up its cloud runtime, credentials, and pending usage reservations.",
        warning: locale === "zh"
          ? "此操作不可撤销。再次使用需要重新创建 Agent。"
          : "This action cannot be undone. Create a new Bot if you need it again.",
        targetAgent: locale === "zh" ? "即将删除：" : "Bot to delete: ",
        confirm: locale === "zh" ? "确认删除" : "Confirm Delete",
        loading: locale === "zh" ? "删除中..." : "Deleting...",
        failed: locale === "zh" ? "删除云端 Agent 失败" : "Failed to delete Cloud Bot",
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

  return (
    <DialogShell
      title={copy.title}
      description={copy.description}
      icon={<Unlink className="h-5 w-5 text-danger" />}
      busy={loading}
      onClose={onClose}
      footer={(close) => (
        <>
          <Button variant="ghost" onClick={close} disabled={loading}>
            {t.cancel}
          </Button>
          <UnbindConfirmButton
            agentId={agentId}
            isCloudDelete={isCloudDelete}
            loading={loading}
            label={loading ? copy.loading : copy.confirm}
            failedMessage={copy.failed}
            onUnbound={onUnbound}
            setLoading={setLoading}
            setError={setError}
          />
        </>
      )}
    >
      <div className="rounded-xl border border-warning/25 bg-warning-soft p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
          <p className="text-xs text-warning">{copy.warning}</p>
        </div>
      </div>

      <p className="mt-4 text-xs text-text-secondary">
        {copy.targetAgent}
        <span className="text-text-primary">{agentName}</span>
      </p>

      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}
    </DialogShell>
  );
}

// Lives inside DialogShell so it can close the dialog with its exit animation
// once the unbind / delete succeeds.
function UnbindConfirmButton({
  agentId,
  isCloudDelete,
  loading,
  label,
  failedMessage,
  onUnbound,
  setLoading,
  setError,
}: {
  agentId: string;
  isCloudDelete: boolean;
  loading: boolean;
  label: string;
  failedMessage: string;
  onUnbound: (agentId: string) => Promise<void> | void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}) {
  const closeDialog = useDialogClose();

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
      closeDialog();
    } catch (err: any) {
      setError(err?.message || failedMessage);
      setLoading(false);
    }
  }

  return (
    <Button variant="danger" onClick={handleUnbind} loading={loading}>
      {label}
    </Button>
  );
}
