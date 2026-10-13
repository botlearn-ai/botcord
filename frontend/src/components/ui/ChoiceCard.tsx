/**
 * [INPUT]: 原生 radio 属性、标题与说明；依赖 Radio 与 VI 语义色
 * [OUTPUT]: 对外提供 ChoiceCard：整块可点击的选项卡片，选中时 accent-soft 背景，禁用时降低不透明度
 * [POS]: ui 表单原语；角色、权限、方案等“带说明的单选”统一从这里出。外层由调用方提供 fieldset + legend
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；保留原生 name / value / checked / onChange
 */

import { forwardRef } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";
import Radio from "./Radio";

export interface ChoiceCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "title"> {
  title: ReactNode;
  description?: ReactNode;
}

const ChoiceCard = forwardRef<HTMLInputElement, ChoiceCardProps>(function ChoiceCard(
  { title, description, checked, disabled, className, ...rest },
  ref,
) {
  return (
    <label
      data-checked={checked ? "true" : undefined}
      className={clsx(
        "bc-touch-target flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors duration-[var(--bc-duration-fast)] motion-reduce:transition-none",
        checked ? "border-accent/30 bg-accent-soft" : "border-border bg-surface hover:border-border-strong",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <Radio {...rest} ref={ref} checked={checked} disabled={disabled} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-text-primary">{title}</span>
        {description ? <span className="block text-xs leading-5 text-text-secondary">{description}</span> : null}
      </span>
    </label>
  );
});

export default ChoiceCard;
