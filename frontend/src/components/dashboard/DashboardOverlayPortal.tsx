"use client";

/**
 * [INPUT]: receives a viewport-level dashboard overlay as children
 * [OUTPUT]: renders it in the shared overlay host, outside local stacking contexts
 * [POS]: dashboard-wide escape hatch for dialogs, drawers, and blocking scrims
 * [PROTOCOL]: keep the overlay root itself responsible for its z-index; use this
 * component for full-viewport overlays, not anchored menus or tooltips
 */

import { useLayoutEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { createPortal } from "react-dom";

const OVERLAY_HOST_ID = "dashboard-overlay-root";

const OVERLAY_LAYER_STACK_BASE: Record<DashboardOverlayLayer, number> = {
  modal: 1_000_000,
  nested: 2_000_000,
  critical: 3_000_000,
};

let nextOverlayOpenOrder = 0;

/**
 * Gives every visible overlay a deterministic position in the global stack.
 * A later modal must win over an earlier modal even when their React owners
 * live in different dashboard panes.
 */
export function getDashboardOverlayStackIndex(
  layer: DashboardOverlayLayer,
  openOrder: number,
): number {
  return OVERLAY_LAYER_STACK_BASE[layer] + openOrder;
}

function claimDashboardOverlayStackIndex(layer: DashboardOverlayLayer): number {
  nextOverlayOpenOrder += 1;
  return getDashboardOverlayStackIndex(layer, nextOverlayOpenOrder);
}

function getOverlayHost(): HTMLElement {
  const existing = document.getElementById(OVERLAY_HOST_ID);
  if (existing) return existing;

  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  host.setAttribute("aria-live", "off");
  document.body.appendChild(host);
  return host;
}

interface DashboardOverlayPortalProps {
  children: ReactNode;
  layer?: DashboardOverlayLayer;
}

export type DashboardOverlayLayer = "modal" | "nested" | "critical";

export default function DashboardOverlayPortal({
  children,
  layer = "modal",
}: DashboardOverlayPortalProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [stackIndex, setStackIndex] = useState<number | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const isActiveRef = useRef(false);

  // Render in place for SSR, then move before the browser paints. This keeps
  // the modal's existing ref-driven enter animations intact while avoiding a
  // hydration-only portal branch.
  useLayoutEffect(() => {
    setHost(getOverlayHost());
  }, []);

  // Several dashboard overlays are mounted permanently and only render their
  // scrim when store state opens them. Watch the rendered DOM rather than the
  // HOC's mount order, so an overlay opened later always rises above its peers.
  useLayoutEffect(() => {
    const layerNode = layerRef.current;
    if (!layerNode) return;

    const syncActiveState = () => {
      const isActive = layerNode.childElementCount > 0;
      if (isActive && !isActiveRef.current) {
        setStackIndex(claimDashboardOverlayStackIndex(layer));
      } else if (!isActive && isActiveRef.current) {
        setStackIndex(null);
      }
      isActiveRef.current = isActive;
    };

    syncActiveState();
    const observer = new MutationObserver(syncActiveState);
    observer.observe(layerNode, { childList: true });
    return () => observer.disconnect();
  }, [host, layer]);

  return host
    ? createPortal(
      <div
        ref={layerRef}
        className={`dashboard-overlay-layer dashboard-overlay-layer-${layer}`}
        style={stackIndex === null ? undefined : { zIndex: stackIndex }}
      >
        {children}
      </div>,
      host,
    )
    : children;
}

/**
 * Keep full-screen overlay implementations self-contained: callers do not
 * need to know whether an action originated in the sidebar, a drawer, or the
 * main pane in order to get correct viewport-level stacking.
 */
export function withDashboardOverlayPortal<Props extends object>(
  OverlayComponent: ComponentType<Props>,
  layer: DashboardOverlayLayer = "modal",
) {
  function PortaledDashboardOverlay(props: Props) {
    return (
      <DashboardOverlayPortal layer={layer}>
        <OverlayComponent {...props} />
      </DashboardOverlayPortal>
    );
  }

  PortaledDashboardOverlay.displayName = `withDashboardOverlayPortal(${OverlayComponent.displayName || OverlayComponent.name || "Overlay"})`;
  return PortaledDashboardOverlay;
}
