"use client";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import { useCallback, useState, useEffect, useRef } from "react";
import { useLanguage } from '@/lib/i18n';
import { topupDialog } from '@/lib/i18n/translations/dashboard';
import { api, ApiError, type ActiveIdentity } from "@/lib/api";
import { animateOverlayPanelEnter, animateOverlayPanelExit, animatePop, cleanupAnime } from "@/lib/anime";
import type { StripePackageItem } from "@/lib/types";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { saveStripeTopupContext } from "@/lib/stripe-topup-context";
import { Loader2, X } from "lucide-react";
import { BotCordLoadingBlock } from "@/components/ui/BotCordLoader";
import WalletAccountSelector from "./WalletAccountSelector";

function formatCoin(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  return (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFiat(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface TopupDialogProps {
  /**
   * Identity that owns the wallet receiving the topup. Defaults to the
   * global active identity when ``null``.
   */
  viewer?: ActiveIdentity | null;
  onClose: () => void;
  onSuccess: () => void;
}

export default withDashboardOverlayPortal(TopupDialog, "nested");

function TopupDialog({ viewer, onClose, onSuccess }: TopupDialogProps) {
  const locale = useLanguage();
  const t = topupDialog[locale];
  const human = useDashboardSessionStore((s) => s.human);
  const isAuthed = useDashboardSessionStore((state) => state.sessionMode !== "guest");
  // Selected destination account — defaults to the explicit viewer, otherwise "我".
  const [selectedViewer, setSelectedViewer] = useState<ActiveIdentity | null>(() => {
    if (viewer) return viewer;
    return human?.human_id ? { type: "human", id: human.human_id } : null;
  });
  const [packages, setPackages] = useState<StripePackageItem[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [packagesError, setPackagesError] = useState("");
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const errorAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

  useEffect(() => {
    api.getStripePackages()
      .then((res) => {
        setPackages(res.packages);
        setSelectedPackage((current) => current ?? res.packages[0]?.package_code ?? null);
        setPackagesLoading(false);
      })
      .catch((err) => {
        setPackagesError(err instanceof ApiError ? err.message : "Failed to load packages");
        setPackagesLoading(false);
      });
  }, []);

  const activePackage = packages.find((pkg) => pkg.package_code === selectedPackage) ?? packages[0] ?? null;
  const unitCoinMinor = parseInt(activePackage?.coin_amount_minor ?? "0", 10);
  const unitFiat = Number.parseFloat(activePackage?.fiat_amount ?? "0");
  const normalizedUnitFiat = Number.isFinite(unitFiat) ? unitFiat : 0;
  const totalCoinMinor = Number.isFinite(unitCoinMinor) ? unitCoinMinor * quantity : 0;
  const totalFiat = normalizedUnitFiat * quantity;

  const updateQuantity = (next: number) => {
    if (!Number.isFinite(next)) return;
    setQuantity(Math.max(1, Math.min(100, Math.trunc(next))));
  };

  const handleCheckout = async () => {
    if (!activePackage || !isAuthed) return;
    setError("");
    setSubmitting(true);

    try {
      const res = await api.createStripeCheckoutSession({
        package_code: activePackage.package_code,
        idempotency_key: crypto.randomUUID(),
        quantity,
      }, selectedViewer);
      // Stash the viewer so StripeReturnBanner can poll status against the
      // same owner after Stripe redirects back (the URL only carries the
      // session_id; backend get_checkout_status requires a matching owner).
      saveStripeTopupContext(res.checkout_session_id, selectedViewer ?? null);
      window.location.assign(res.checkout_url);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t.rechargeFailed);
      }
      setSubmitting(false);
    }
  };

  const closeWithMotion = useCallback(() => {
    if (submitting || closing) return;
    setClosing(true);
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      onComplete: onClose,
    });
  }, [closing, onClose, submitting]);

  useEffect(() => {
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; } });
    return () => cleanupAnime(animationRef.current);
  }, []);

  useEffect(() => {
    if (!error || !errorRef.current) return;
    cleanupAnime(errorAnimationRef.current);
    errorAnimationRef.current = animatePop(errorRef.current);
    return () => cleanupAnime(errorAnimationRef.current);
  }, [error]);

  return (
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithMotion} title={<>{t.recharge}</>} busy={submitting} overlayClassName="z-50" className="max-w-md">
        <IconButton label="Close"
          onClick={closeWithMotion}
          className="absolute right-4 z-10"
        >
          <X aria-hidden strokeWidth={1.75} className="h-4 w-4" />
        </IconButton>

        <div className="shrink-0 px-6 pt-6 pb-3">
          <h3 className="text-lg font-semibold text-text-primary">{t.recharge}</h3>
          <p className="text-xs text-text-secondary">{t.description}</p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
        <WalletAccountSelector value={selectedViewer} onChange={setSelectedViewer} />

        {packagesLoading ? (
          <BotCordLoadingBlock
            label={t.loadingPackages}
            className="py-8"
          />
        ) : packagesError ? (
          <Alert tone="danger" >{packagesError}</Alert>
        ) : packages.length === 0 ? (
          <div className="py-8 text-center text-sm text-text-secondary">
            {t.noPackages}
          </div>
        ) : (
          <>
            {packages.length > 1 ? (
              <div className="space-y-3">
                {packages.map((pkg) => (
                  <Button aria-pressed={activePackage?.package_code === pkg.package_code} variant="row"
                    key={pkg.package_code}
                    onClick={() => setSelectedPackage(pkg.package_code)}
                    className="w-full"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-sm font-semibold text-text-primary">
                        {formatCoin(pkg.coin_amount_minor)} COIN / ${pkg.fiat_amount || formatFiat(0)}
                      </span>
                      <Badge tone="accent" >
                        {pkg.fiat_amount ? `$${pkg.fiat_amount}` : pkg.currency.toUpperCase()}
                      </Badge>
                    </div>
                  </Button>
                ))}
              </div>
            ) : activePackage ? (
              <Card padding="none" className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-text-secondary">
                    {t.unitPrice}
                  </span>
                  <Badge tone="accent" >
                    {activePackage.fiat_amount ? `$${activePackage.fiat_amount}` : activePackage.currency.toUpperCase()}
                  </Badge>
                </div>
                <div className="mt-2 font-mono text-lg font-semibold text-text-primary">
                  {formatCoin(activePackage.coin_amount_minor)} COIN / ${activePackage.fiat_amount || formatFiat(0)}
                </div>
              </Card>
            ) : null}

            {activePackage ? (
              <>
                <Card padding="none" className="mt-4 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">{t.quantity}</span>
                    <span className="text-xs text-text-secondary">{t.quantityRange}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button variant="secondary"
                      type="button"
                      onClick={() => updateQuantity(quantity - 1)}
                      disabled={quantity <= 1 || submitting}
                      className="w-10"
                    >
                      -
                    </Button>
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={quantity}
                      onChange={(e) => updateQuantity(parseInt(e.target.value, 10))}
                      className="flex-1"
                    />
                    <Button variant="secondary"
                      type="button"
                      onClick={() => updateQuantity(quantity + 1)}
                      disabled={quantity >= 100 || submitting}
                      className="w-10"
                    >
                      +
                    </Button>
                  </div>
                </Card>

                <Card padding="none" className="mt-4 p-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-text-secondary">{t.perUnit}</span>
                    <span className="font-mono text-text-primary">
                      {formatCoin(activePackage.coin_amount_minor)} COIN / ${formatFiat(normalizedUnitFiat)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-sm">
                    <span className="text-text-secondary">{t.quantity}</span>
                    <span className="font-mono text-text-primary">{quantity}</span>
                  </div>
                  <div className="mt-3 border-t border-glass-border pt-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-text-primary">{t.total}</span>
                      <div className="text-right">
                        <div className="font-mono text-base font-semibold text-neon-green">
                          {formatCoin(String(totalCoinMinor))} COIN
                        </div>
                        <div className="text-xs text-text-secondary">
                          ${formatFiat(totalFiat)} {activePackage.currency.toUpperCase()}
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              </>
            ) : null}

            {error && <Alert tone="danger" ref={errorRef} className="mt-3">{error}</Alert>}
          </>
        )}

        <p className="mt-3 text-center text-xs text-text-secondary">
          {t.securePayment}
        </p>
        </div>

        {!packagesLoading && !packagesError && packages.length > 0 ? (
          <div className="liquid-toolbar shrink-0 border-t px-6 py-4">
            <Button variant="secondary"
              onClick={handleCheckout}
              disabled={!activePackage || submitting}
              className="w-full"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {submitting ? t.redirectingToStripe : `${t.continueToPayment}${activePackage ? ` • $${formatFiat(totalFiat)}` : ""}`}
            </Button>
          </div>
        ) : null}
      </DialogSurface>
  );
}
