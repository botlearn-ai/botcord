"use client";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import Button from "@/components/ui/Button";
import DialogShell from "@/components/ui/DialogShell";
import { useLanguage } from "@/lib/i18n";
import { roomAdvancedSettings } from "@/lib/i18n/translations/dashboard";

interface PlanChangeConfirmDialogProps {
  fromLabel: string;
  toLabel: string;
  affectedCount: number;
  loading?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export default withDashboardOverlayPortal(PlanChangeConfirmDialog, "nested");

function PlanChangeConfirmDialog({
  fromLabel,
  toLabel,
  affectedCount,
  loading = false,
  onClose,
  onConfirm,
}: PlanChangeConfirmDialogProps) {
  const locale = useLanguage();
  const ta = roomAdvancedSettings[locale];

  const fromTo = ta.planChangeFromTo
    .replace("{from}", fromLabel)
    .replace("{to}", toLabel);
  const warning = ta.planChangeWarning.replace(
    "{count}",
    String(affectedCount),
  );

  return (
    <DialogShell
      title={ta.planChangeTitle}
      busy={loading}
      onClose={onClose}
      closeLabel={ta.planChangeCancel}
      overlayClassName="z-[80]"
      footer={(close) => (
        <>
          <Button variant="ghost" size="sm" onClick={close} disabled={loading}>
            {ta.planChangeCancel}
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm} loading={loading}>
            {ta.planChangeConfirm}
          </Button>
        </>
      )}
    >
      <p className="text-sm text-text-primary/90">{fromTo}</p>
      {affectedCount > 0 ? (
        <p className="mt-3 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-xs text-warning">
          ⚠️ {warning}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-text-secondary">{ta.planChangeIrreversible}</p>
    </DialogShell>
  );
}
