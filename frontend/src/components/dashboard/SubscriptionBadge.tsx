"use client";

/**
 * [INPUT]: 依赖 subscriptions BFF、session/chat/subscription store 与可选 roomId，动态加载商品详情与当前 agent 订阅状态
 * [OUTPUT]: 对外提供 SubscriptionBadge 组件，渲染订阅 badge/按钮并在弹层里展示价格、周期、状态与订阅操作
 * [POS]: dashboard 各类房间卡片与消息头的统一订阅入口，连接"看见门槛"与"立即订阅"
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import DialogSurface from "@/components/ui/DialogSurface";
import Button from "@/components/ui/Button";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/i18n";
import { subscriptionBadge } from "@/lib/i18n/translations/dashboard";
import { api } from "@/lib/api";
import type { SubscriptionProduct } from "@/lib/types";
import { useShallow } from "zustand/react/shallow";
import { Loader2 } from "lucide-react";
import { MobileBotCordLoading } from "@/components/ui/BotCordLoader";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardSubscriptionStore } from "@/store/useDashboardSubscriptionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";
import DashboardOverlayPortal from "./DashboardOverlayPortal";

interface SubscriptionBadgeProps {
  productId?: string | null;
  roomId?: string | null;
  className?: string;
  variant?: "badge" | "button";
  triggerLabel?: string;
  loginHref?: string;
}

const productCache = new Map<string, SubscriptionProduct>();
const INSUFFICIENT_BALANCE_RE = /insufficient|balance|fund|not enough/i;
const ALREADY_SUBSCRIBED_RE = /already.+subscri/i;

function mapApiErrorToI18n(
  raw: string,
  t: (typeof subscriptionBadge)["en"],
): string {
  if (INSUFFICIENT_BALANCE_RE.test(raw)) return t.errorInsufficientBalance;
  if (ALREADY_SUBSCRIBED_RE.test(raw)) return t.errorAlreadySubscribed;
  return raw || t.errorGeneric;
}

export default function SubscriptionBadge({
  productId,
  roomId,
  className = "",
  variant = "badge",
  triggerLabel,
  loginHref,
}: SubscriptionBadgeProps) {
  const router = useRouter();
  const locale = useLanguage();
  const t = subscriptionBadge[locale];
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [productData, setProductData] = useState<SubscriptionProduct | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<"generic" | "insufficient_balance">("generic");
  const [subscribing, setSubscribing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);

  const { activeAgentId, sessionMode, activeIdentityType } = useDashboardSessionStore(useShallow((state) => ({
    activeAgentId: state.activeAgentId,
    sessionMode: state.sessionMode,
    activeIdentityType: state.activeIdentity?.type ?? null,
  })));
  const isAgentMode = activeIdentityType === "agent" && !!activeAgentId;
  const { joinRoom } = useDashboardChatStore(useShallow((state) => ({
    joinRoom: state.joinRoom,
  })));
  const {
    setSidebarTab,
    setFocusedRoomId,
    setOpenedRoomId,
    setMessagesPane,
    startPrimaryNavigation,
  } = useDashboardUIStore(useShallow((state) => ({
    setSidebarTab: state.setSidebarTab,
    setFocusedRoomId: state.setFocusedRoomId,
    setOpenedRoomId: state.setOpenedRoomId,
    setMessagesPane: state.setMessagesPane,
    startPrimaryNavigation: state.startPrimaryNavigation,
  })));
  const {
    getActiveSubscription,
    ensureSubscriptions,
    subscribeToProduct,
  } = useDashboardSubscriptionStore(useShallow((state) => ({
    getActiveSubscription: state.getActiveSubscription,
    ensureSubscriptions: state.ensureSubscriptions,
    subscribeToProduct: state.subscribeToProduct,
  })));
  const isGuest = sessionMode === "guest";
  const isAuthedReady = sessionMode === "authed-ready";
  const subscription = productId ? getActiveSubscription(productId) : null;
  const showLoginModal = () => {
    if (typeof window !== "undefined") {
      window.location.href = loginHref || "/login";
    }
  };
  const alreadySubscribed = subscription?.status === "active";
  const isInsufficientBalance = errorKind === "insufficient_balance";

  const closeWithMotion = useCallback((afterClose?: () => void) => {
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      contentSelector: "[data-motion-item]",
      onComplete: () => {
        setShowModal(false);
        afterClose?.();
      },
    });
  }, []);

  const handleOpenWallet = () => {
    closeWithMotion(() => {
      setSidebarTab("wallet");
      router.push("/chats/wallet");
    });
  };

  // Eagerly load product data on mount so the badge can show subscriber count
  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    if (productCache.has(productId)) {
      setProductData(productCache.get(productId)!);
    } else {
      api.getSubscriptionProduct(productId)
        .then((res) => {
          if (cancelled) return;
          productCache.set(productId, res.product);
          setProductData(res.product);
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [productId]);

  useEffect(() => {
    let cancelled = false;
    if (!isAuthedReady || !isAgentMode) {
      return () => {
        cancelled = true;
      };
    }

    ensureSubscriptions()
      .then(() => {
        if (cancelled) return;
      })
      .catch(() => {
        if (cancelled) return;
      });
    return () => {
      cancelled = true;
    };
  }, [activeAgentId, isAgentMode, ensureSubscriptions, isAuthedReady]);

  useEffect(() => {
    if (!showModal) return;
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, {
      contentSelector: "[data-motion-item]",
      onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; },
    });
    return () => cleanupAnime(animationRef.current);
  }, [closeWithMotion, showModal]);

  if (!productId) return null;

  const loadData = async () => {
    const productPromise = productCache.has(productId)
      ? Promise.resolve({ product: productCache.get(productId)! })
      : api.getSubscriptionProduct(productId);
    const [productResult] = await Promise.all([
      productPromise,
      isAuthedReady && isAgentMode ? ensureSubscriptions() : Promise.resolve([]),
    ]);

    productCache.set(productId, productResult.product);
    setProductData(productResult.product);
  };

  const handleOpen = async (event: React.MouseEvent) => {
    event.stopPropagation();
    setShowModal(true);
    setLoading(true);
    setError(null);
    setErrorKind("generic");
    try {
      await loadData();
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      setError(raw || t.failedToLoad);
      setProductData(null);
    } finally {
      setLoading(false);
    }
  };

  const handlePrimaryAction = async () => {
    if (isGuest) {
      showLoginModal();
      return;
    }
    if (!isAuthedReady || !isAgentMode) {
      setError(t.selectAgentFirst);
      return;
    }

    setSubscribing(true);
    setError(null);
    setErrorKind("generic");
    try {
      if (!alreadySubscribed) {
        await subscribeToProduct(productId, roomId ? { roomId } : undefined);
      }
      if (roomId) {
        await joinRoom(roomId);
        const path = "/chats/messages";
        setMessagesPane("room");
        setFocusedRoomId(roomId);
        setOpenedRoomId(roomId);
        startPrimaryNavigation("messages", path);
        router.push(path);
      }
      closeWithMotion();
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      setErrorKind(INSUFFICIENT_BALANCE_RE.test(raw) ? "insufficient_balance" : "generic");
      setError(mapApiErrorToI18n(raw, t));
    } finally {
      setSubscribing(false);
    }
  };

  const badgeLabel = alreadySubscribed ? t.subscribed : t.paid;
  const badgeClasses = alreadySubscribed
    ? "bg-success-soft text-success hover:bg-success-soft"
    : "bg-warning-soft text-warning hover:bg-warning-soft";
  const primaryLabel = isGuest
    ? t.loginToSubscribe
    : !isAuthedReady || !isAgentMode
      ? t.selectActiveAgent
      : roomId
        ? alreadySubscribed
          ? t.joinRoom
          : t.subscribeToJoin
        : alreadySubscribed
          ? t.subscriptionActive
          : t.startSubscription;

  const formatAmount = (minor: number, _assetCode: string) =>
    `${(minor / 100).toFixed(2)} Coin`;

  const trigger = variant === "button" ? (
    <Button variant="secondary" size="sm"
      onClick={handleOpen}

      title={alreadySubscribed ? t.subscriptionActiveTip : t.subscriptionRequiredTip}
    >
      {triggerLabel || t.joinRoom}
    </Button>
  ) : (
    <Button variant="inline"
      onClick={handleOpen}
      className={`inline-flex items-center gap-1  `}
      title={alreadySubscribed ? t.subscriptionActiveTip : t.subscriptionRequiredTip}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
      {triggerLabel || badgeLabel}
      {productData?.active_subscriber_count != null && (
        <span className="ml-0.5 opacity-75">· {productData.active_subscriber_count}</span>
      )}
    </Button>
  );

  return (
    <>
      {trigger}

      {showModal && (
        <DashboardOverlayPortal>
          <DialogSurface overlayRef={overlayRef} panelRef={panelRef} title={t.modalTitle} onClose={() => closeWithMotion()} busy={subscribing} size="sm" className="overflow-y-auto p-6">
            <h2 data-motion-item className="mb-2 flex items-center gap-2 text-lg font-semibold text-warning">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              {t.modalTitle}
            </h2>

            {loading ? (
              <MobileBotCordLoading
                label={t.loading}
                className="py-8"
                textClassName="text-center text-sm text-text-secondary animate-pulse"
              />
            ) : productData ? (
              <div data-motion-item className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-medium text-text-primary">{productData.name}</h3>
                    {productData.description ? (
                      <p className="mt-1 text-sm text-text-secondary">{productData.description}</p>
                    ) : null}
                  </div>
                  <Badge tone="warning"

                  >
                    {alreadySubscribed ? t.active : t.required}
                  </Badge>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-warning/40 bg-warning-soft p-4">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-text-secondary">{t.price}</div>
                    <div className="text-xl font-semibold text-warning">
                      {formatAmount(productData.amount_minor, productData.asset_code)}
                    </div>
                  </div>
                  {productData.active_subscriber_count != null && (
                    <div className="text-center">
                      <div className="text-xs uppercase tracking-wider text-text-secondary">{t.subscribers}</div>
                      <div className="font-medium text-text-primary">
                        {productData.active_subscriber_count}
                      </div>
                    </div>
                  )}
                  <div className="text-right">
                    <div className="text-xs uppercase tracking-wider text-text-secondary">{t.billing}</div>
                    <div className="font-medium capitalize text-text-primary">
                      {productData.billing_interval}
                    </div>
                  </div>
                </div>

                {subscription ? (
                  <div className="rounded border border-neon-green/30 bg-success-soft px-3 py-2 text-xs text-success">
                    {t.activeUntil} {new Date(subscription.current_period_end).toLocaleString()}
                  </div>
                ) : null}

                {!subscription && !isGuest && !isAgentMode ? (
                  <div className="rounded border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">
                    {t.chooseAgentHint}
                  </div>
                ) : null}

                {error ? (
                  <Alert tone="danger" className="flex items-start gap-2">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                      <span>{error}</span>
                      {isInsufficientBalance ? (
                        <Button variant="danger" size="sm"
                          onClick={handleOpenWallet}
                          className="shrink-0"
                        >
                          Top up wallet
                        </Button>
                      ) : null}
                    </div>
                  </Alert>
                ) : null}

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="secondary" size="sm"
                    onClick={() => closeWithMotion()}

                  >
                    {t.close}
                  </Button>
                  <Button variant="secondary" size="sm"
                    onClick={handlePrimaryAction}
                    disabled={subscribing || (!isGuest && !isAgentMode)}
                    className="inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    {subscribing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {subscribing ? t.processing : primaryLabel}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <Alert tone="danger" className="flex items-start gap-2">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>{error || t.failedToLoadDetails}</span>
                </Alert>
                <div className="flex justify-end">
                  <Button variant="secondary" size="sm"
                    onClick={() => closeWithMotion()}

                  >
                    {t.close}
                  </Button>
                </div>
              </div>
            )}
          </DialogSurface>
        </DashboardOverlayPortal>
      )}
    </>
  );
}
