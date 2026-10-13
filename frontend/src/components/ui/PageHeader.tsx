/**
 * [INPUT]: 标题、可选 eyebrow / 说明 / 图标 / 操作；依赖 VI 字体类（type-caption、type-heading-*）与 clsx
 * [OUTPUT]: 对外提供 PageHeader：页面或引导区块的标题组，start / center 两种对齐；level 1 渲染 h1（VI h2 28px），level 2 渲染 h2（VI h3 22px）
 * [POS]: ui 布局原语；dashboard 内的页面标题、邀请落地页、空引导标题统一从这里出。营销页区块标题用 SectionHeading
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；eyebrow 不转大写、不加字距
 */

import type { HTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** Usually an IconTile. Rendered beside the title (start) or above it (center). */
  icon?: ReactNode;
  actions?: ReactNode;
  align?: "start" | "center";
  level?: 1 | 2;
}

export default function PageHeader({ title, eyebrow, description, icon, actions, align = "start", level = 1, className, ...rest }: PageHeaderProps) {
  const Heading = level === 1 ? "h1" : "h2";
  const center = align === "center";
  return (
    <header
      {...rest}
      className={clsx(center ? "flex flex-col items-center text-center" : "flex flex-wrap items-start justify-between gap-4", className)}
    >
      <div className={clsx("min-w-0", center ? "flex flex-col items-center" : "flex-1")}>
        {eyebrow ? <p className="type-caption mb-2 text-accent-text">{eyebrow}</p> : null}
        <div className={clsx(center ? "flex flex-col items-center gap-5" : "flex items-center gap-3")}>
          {icon}
          <Heading className={clsx("min-w-0 break-words text-text-primary", level === 1 ? "type-heading-2" : "type-heading-3")}>{title}</Heading>
        </div>
        {description ? (
          <p className={clsx("mt-3 max-w-xl text-sm leading-6 text-text-secondary", center && "mx-auto")}>{description}</p>
        ) : null}
      </div>
      {actions ? <div className={clsx("flex shrink-0 flex-wrap gap-2", center && "mt-5 justify-center")}>{actions}</div> : null}
    </header>
  );
}
