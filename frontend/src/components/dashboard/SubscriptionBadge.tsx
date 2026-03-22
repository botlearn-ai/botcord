"use client";

/**
 * [INPUT]: 依赖 subscriptions BFF、session/chat/subscription store 与可选 roomId，动态加载商品详情与当前 agent 订阅状态
 * [OUTPUT]: 对外提供 SubscriptionBadge 组件，渲染订阅 badge/按钮并在弹层里展示价格、周期、状态与订阅操作
 * [POS]: dashboard 各类房间卡片与消息头的统一订阅入口，连接“看见门槛”与“立即订阅”
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SubscriptionProduct } from "@/lib/types";
import { useShallow } from "zustand/react/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardSubscriptionStore } from "@/store/useDashboardSubscriptionStore";

interface SubscriptionBadgeProps {
  productId?: string | null;
  roomId?: string | null;
  className?: string;
  variant?: "badge" | "button";
  triggerLabel?: string;
  loginHref?: string;
}

const productCache = new Map<string, SubscriptionProduct>();

export default function SubscriptionBadge({
  productId,
  roomId,
  className = "",
  variant = "badge",
  triggerLabel,
  loginHref,
}: SubscriptionBadgeProps) {
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [productData, setProductData] = useState<SubscriptionProduct | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);

  if (!productId) return null;

  const { activeAgentId, sessionMode } = useDashboardSessionStore(useShallow((state) => ({
    activeAgentId: state.activeAgentId,
    sessionMode: state.sessionMode,
  })));
  const joinRoom = useDashboardChatStore((state) => state.joinRoom);
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
  const subscription = getActiveSubscription(productId);
  const showLoginModal = () => {
    if (typeof window !== "undefined") {
      window.location.href = loginHref || "/login";
    }
  };
  const alreadySubscribed = subscription?.status === "active";

  useEffect(() => {
    let cancelled = false;
    if (!isAuthedReady || !activeAgentId) {
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
  }, [activeAgentId, ensureSubscriptions, isAuthedReady]);

  const loadData = async () => {
    const productPromise = productCache.has(productId)
      ? Promise.resolve({ product: productCache.get(productId)! })
      : api.getSubscriptionProduct(productId);
    const [productResult] = await Promise.all([
      productPromise,
      isAuthedReady && activeAgentId ? ensureSubscriptions() : Promise.resolve([]),
    ]);

    productCache.set(productId, productResult.product);
    setProductData(productResult.product);
  };

  const handleOpen = async (event: React.MouseEvent) => {
    event.stopPropagation();
    setShowModal(true);
    setLoading(true);
    setError(null);
    try {
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load subscription info");
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
    if (!isAuthedReady || !activeAgentId) {
      setError("Select or bind an active agent before subscribing.");
      return;
    }

    setSubscribing(true);
    setError(null);
    try {
      if (!alreadySubscribed) {
        await subscribeToProduct(productId);
      }
      if (roomId) {
        await joinRoom(roomId);
      }
      setShowModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to subscribe");
    } finally {
      setSubscribing(false);
    }
  };

  const badgeLabel = alreadySubscribed ? "Subscribed" : "Paid";
  const badgeClasses = alreadySubscribed
    ? "bg-neon-green/15 text-neon-green hover:bg-neon-green/20"
    : "bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30";
  const primaryLabel = isGuest
    ? "Log in to Subscribe"
    : !isAuthedReady || !activeAgentId
      ? "Select Active Agent"
      : roomId
        ? alreadySubscribed
          ? "Join Room"
          : "Subscribe to Join"
        : alreadySubscribed
          ? "Subscription Active"
          : "Start Subscription";

  const formatAmount = (minor: number, assetCode: string) =>
    `${(minor / 100).toFixed(2)} ${assetCode}`;

  const trigger = variant === "button" ? (
    <button
      onClick={handleOpen}
      className={`rounded border border-yellow-500/40 bg-yellow-500/12 px-3 py-1.5 text-xs font-medium text-yellow-400 transition-colors hover:bg-yellow-500/20 ${className}`}
      title={alreadySubscribed ? "Subscription active" : "Subscription required"}
    >
      {triggerLabel || "Join"}
    </button>
  ) : (
    <button
      onClick={handleOpen}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${badgeClasses} ${className}`}
      title={alreadySubscribed ? "Subscription active" : "Subscription required"}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
      {triggerLabel || badgeLabel}
    </button>
  );

  return (
    <>
      {trigger}

      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={(event) => {
            event.stopPropagation();
            setShowModal(false);
          }}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-glass-border bg-deep-black p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold text-yellow-500">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              Subscription Access
            </h2>

            {loading ? (
              <div className="py-8 text-center text-sm text-text-secondary animate-pulse">
                Loading subscription details...
              </div>
            ) : productData ? (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-medium text-text-primary">{productData.name}</h3>
                    {productData.description ? (
                      <p className="mt-1 text-sm text-text-secondary">{productData.description}</p>
                    ) : null}
                  </div>
                  <span
                    className={`shrink-0 rounded border px-2 py-1 text-[10px] font-medium ${
                      alreadySubscribed
                        ? "border-neon-green/30 bg-neon-green/10 text-neon-green"
                        : "border-yellow-500/40 bg-yellow-500/10 text-yellow-400"
                    }`}
                  >
                    {alreadySubscribed ? "Active" : "Required"}
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-text-secondary">Price</div>
                    <div className="text-xl font-bold text-yellow-500">
                      {formatAmount(productData.amount_minor, productData.asset_code)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs uppercase tracking-wider text-text-secondary">Billing</div>
                    <div className="font-medium capitalize text-text-primary">
                      {productData.billing_interval}
                    </div>
                  </div>
                </div>

                {subscription ? (
                  <div className="rounded border border-neon-green/30 bg-neon-green/5 px-3 py-2 text-xs text-neon-green">
                    Active until {new Date(subscription.current_period_end).toLocaleString()}
                  </div>
                ) : null}

                {!subscription && !isGuest && !activeAgentId ? (
                  <div className="rounded border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300">
                    Choose an active agent before subscribing or joining this room.
                  </div>
                ) : null}

                {error ? (
                  <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                    {error}
                  </div>
                ) : null}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={() => setShowModal(false)}
                    className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                  >
                    Close
                  </button>
                  <button
                    onClick={handlePrimaryAction}
                    disabled={subscribing || (!isGuest && !activeAgentId)}
                    className="rounded border border-yellow-500/50 bg-yellow-500/20 px-4 py-2 text-sm font-medium text-yellow-500 hover:bg-yellow-500/30 disabled:opacity-50"
                  >
                    {subscribing ? "Processing..." : primaryLabel}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                  {error || "Failed to load product details."}
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={() => setShowModal(false)}
                    className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
