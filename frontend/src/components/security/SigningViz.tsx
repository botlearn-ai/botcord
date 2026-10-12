/**
 * [INPUT]: 依赖 security i18n 的 signingViz 文案、framer-motion 进入动画与 VI token
 * [OUTPUT]: 对外提供 SigningViz 组件：消息 → 签名 → 信封三段静态示意，段间用水平圆头连线
 * [POS]: 安全页"签名流程"区块；按 VI §6.5 安全场景只用静态图形，不做循环动画
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import Card from "@/components/ui/Card";
import { Fragment } from "react";
import { motion } from "framer-motion";
import { useLanguage } from "@/lib/i18n";
import { signingViz } from "@/lib/i18n/translations/security";

const MotionCard = motion.create(Card);

function Connector() {
  return (
    <svg
      viewBox="0 0 48 16"
      className="mx-auto h-4 w-12 shrink-0 rotate-90 text-[var(--bc-border-strong)] md:rotate-0"
      fill="none"
      aria-hidden="true" >
      <path d="M6 8 H42" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <circle cx={6} cy={8} r={3.5} fill="currentColor" />
      <circle cx={42} cy={8} r={3.5} fill="var(--bc-brand)" />
    </svg>
  );
}

export default function SigningViz() {
  const locale = useLanguage();
  const t = signingViz[locale];

  const panels = [
    { label: t.message, sublabel: t.plainBody },
    { label: t.sign, sublabel: t.ed25519Jcs },
    { label: t.envelope, sublabel: t.signedOutput },
  ];

  return (
    <MotionCard padding="lg"
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.36, ease: [0, 0, 0, 1] }}
      className="flex flex-col items-stretch gap-3 md:flex-row md:items-center" >
      {panels.map((panel, i) => (
        <Fragment key={panel.label}>
          <div
            className={`flex-1 rounded-lg border px-4 py-6 text-center ${
              i === panels.length - 1
                ? "border-[var(--bc-brand)]/40 bg-[var(--bc-accent-soft)]"
                : "border-[var(--bc-border)] bg-[var(--bc-surface-sunken)]"
            }`} >
            <div className="text-base font-semibold text-[var(--bc-text)]">{panel.label}</div>
            <div className="mt-1 font-mono text-xs text-[var(--bc-text-secondary)]">{panel.sublabel}</div>
          </div>
          {i < panels.length - 1 ? <Connector /> : null}
        </Fragment>
      ))}
    </MotionCard>
  );
}
