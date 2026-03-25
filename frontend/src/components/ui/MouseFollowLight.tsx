"use client";

import { useEffect, useRef } from "react";

/**
 * [INPUT]: 依赖浏览器 mousemove 事件与 requestAnimationFrame，同步指针位置到 CSS 变量
 * [OUTPUT]: 对外提供 MouseFollowLight 背景光晕组件
 * [POS]: 首页视觉层的轻量交互光效，避免与重动画争抢主线程
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
export default function MouseFollowLight() {
  const layerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef({ x: -200, y: -200 });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (prefersReduced) return;

    const flush = () => {
      rafRef.current = null;
      const layer = layerRef.current;
      if (!layer) return;
      layer.style.setProperty("--mx", `${targetRef.current.x}px`);
      layer.style.setProperty("--my", `${targetRef.current.y}px`);
    };

    const onMove = (e: MouseEvent) => {
      targetRef.current.x = e.clientX;
      targetRef.current.y = e.clientY;
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(flush);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={layerRef}
      className="pointer-events-none fixed inset-0 z-40 transition-opacity duration-300"
      style={{
        background:
          "radial-gradient(600px circle at var(--mx, -200px) var(--my, -200px), rgba(106,174,181,0.014), transparent 60%)",
      }}
    />
  );
}
