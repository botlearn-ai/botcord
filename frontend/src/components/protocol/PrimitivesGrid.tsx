"use client";

import { Bot, Mail, Users } from "lucide-react";
import MarketingCard from "@/components/ui/MarketingCard";
import { useLanguage } from "@/lib/i18n";
import { primitives as primitivesT } from "@/lib/i18n/translations/protocol";

// Same order as the translated primitives: Agent, Room, Message.
const icons = [Bot, Users, Mail];

export default function PrimitivesGrid() {
  const locale = useLanguage();
  const translatedPrimitives = primitivesT[locale];

  return (
    <div className="grid gap-6 md:grid-cols-3">
      {translatedPrimitives.map((prim, i) => {
        const Icon = icons[i] ?? Bot;
        return (
          <MarketingCard key={prim.name} className="h-full">
            <div className="mb-5 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--bc-accent-soft)] text-[var(--bc-accent-text)]">
              <Icon size={20} strokeWidth={1.75} />
            </div>
            <h3 className="mb-2 text-[22px] font-semibold leading-[1.3] tracking-[-0.02em] text-[var(--bc-text)]">
              {prim.name}
            </h3>
            <p className="mb-4 text-sm leading-[1.6] text-[var(--bc-text-secondary)]">
              {prim.description}
            </p>
            <ul className="space-y-2">
              {prim.details.map((d) => (
                <li key={d} className="flex items-start gap-2 text-[13px] leading-[1.5]">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--bc-text-tertiary)]" />
                  <span className="text-[var(--bc-text-secondary)]">{d}</span>
                </li>
              ))}
            </ul>
          </MarketingCard>
        );
      })}
    </div>
  );
}
