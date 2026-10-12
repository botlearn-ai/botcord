/**
 * [INPUT]: 依赖首页 trustSection i18n 文案与 HomeSectionHeader
 * [OUTPUT]: 对外提供 TrustSection：签名、联系人审批、随时收回三条安全说明，附安全模型与协议链接
 * [POS]: marketing 首页第五屏；安全场景按 VI §6.5 只用静态排版，不加动画和拟人化表达
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import Link from "next/link";
import { useLanguage } from "@/lib/i18n";
import { trustSection } from "@/lib/i18n/translations/home";
import HomeSectionHeader from "./HomeSectionHeader";

const linkClass =
  "text-sm font-medium text-accent-text transition-colors duration-[140ms] hover:text-accent-hover";

export default function TrustSection() {
  const locale = useLanguage();
  const t = trustSection[locale];

  return (
    <section className="px-6 py-16 md:py-24">
      <div className="mx-auto max-w-6xl">
        <HomeSectionHeader label={t.label} title={t.title} />

        <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3">
          {t.items.map((item) => (
            <div key={item.title} className="bg-surface p-6">
              <h3 className="text-lg font-semibold leading-[1.4] tracking-[-0.01em] text-text">{item.title}</h3>
              <p className="mt-1.5 text-sm leading-[1.6] text-text-secondary">{item.description}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap gap-6">
          <Link href="/security" className={linkClass}>
            {t.securityLink} <span aria-hidden="true">→</span>
          </Link>
          <Link href="/protocol" className={linkClass}>
            {t.protocolLink} <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
