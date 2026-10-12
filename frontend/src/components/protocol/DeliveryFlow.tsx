/**
 * [INPUT]: 依赖 protocol i18n 的 deliveryFlow 文案、framer-motion 进入动画与 VI token（--bc-text / --bc-brand / --bc-border-strong）
 * [OUTPUT]: 对外提供 DeliveryFlow 组件：Alice → Hub → Bob 的投递示意，节点间用 logo 同款 S 形连线
 * [POS]: 协议页"消息投递"区块的可视化；信号点沿连线移动，prefers-reduced-motion 时保持静态
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import Card from "@/components/ui/Card";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useLanguage } from "@/lib/i18n";
import { deliveryFlow } from "@/lib/i18n/translations/protocol";

const MotionCard = motion.create(Card);

const VIEW_W = 640;
const VIEW_H = 140;

// Sender sits low-left and receiver high-right, mirroring the Node·Cord mark.
const NODES = [
  { x: 72, y: 100 },
  { x: 320, y: 68 },
  { x: 568, y: 36 },
] as const;

/** Horizontal-tangent cubic between two nodes (VI §5 连线语言). */
function cord(a: { x: number; y: number }, b: { x: number; y: number }) {
  const mx = (a.x + b.x) / 2;
  return `M${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
}

const SEGMENTS = [cord(NODES[0], NODES[1]), cord(NODES[1], NODES[2])];
const ROUTE = `${SEGMENTS[0]} ${SEGMENTS[1].replace(/^M[^C]+/, "")}`;

export default function DeliveryFlow() {
  const locale = useLanguage();
  const t = deliveryFlow[locale];
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setAnimate(!query.matches);
  }, []);

  const labels = [t.alice, t.hub, t.bob];

  return (
    <MotionCard padding="lg"
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.36, ease: [0, 0, 0, 1] }} >
      <div className="relative mx-auto max-w-3xl pb-6">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="block h-auto w-full text-[var(--bc-text)]"
          fill="none"
          role="img"
          aria-label={labels.join(" → ")} >
          {SEGMENTS.map((d) => (
            <path
              key={d}
              d={d}
              stroke="var(--bc-border-strong)"
              strokeWidth={3}
              strokeLinecap="round"
            />
          ))}

          <circle cx={NODES[0].x} cy={NODES[0].y} r={11} fill="currentColor" />
          <circle
            cx={NODES[1].x}
            cy={NODES[1].y}
            r={11}
            fill="var(--bc-surface)"
            stroke="currentColor"
            strokeWidth={3}
          />
          <circle cx={NODES[2].x} cy={NODES[2].y} r={11} fill="var(--bc-brand)" />

          {animate ? (
            <circle r={5} fill="var(--bc-brand)">
              <animateMotion
                path={ROUTE}
                dur="3.2s"
                repeatCount="indefinite"
                keyPoints="0;0.5;0.5;1;1"
                keyTimes="0;0.36;0.5;0.86;1"
                calcMode="linear"
              />
            </circle>
          ) : null}
        </svg>

        {labels.map((label, i) => (
          <span
            key={label}
            className="absolute -translate-x-1/2 whitespace-nowrap text-xs font-medium text-[var(--bc-text-secondary)]"
            style={{
              left: `${(NODES[i].x / VIEW_W) * 100}%`,
              top: `calc(${(NODES[i].y / VIEW_H) * 100}% + 18px)`,
            }} >
            {label}
          </span>
        ))}
      </div>
    </MotionCard>
  );
}
