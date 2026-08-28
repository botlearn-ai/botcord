/**
 * [INPUT]: 依赖 /logo.svg 作为遮罩源与 clsx 组合外部样式
 * [OUTPUT]: 对外提供跟随 currentColor 着色的 BotCord 标志组件
 * [POS]: ui 品牌原语，供 Navbar、Footer 等浅/深双主题表面复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { clsx } from "clsx";

/**
 * The shipped logo asset is a solid white SVG, so an <img> of it vanishes on
 * the light canvas. Painting it as a CSS mask keeps one asset while letting the
 * mark inherit the surrounding text color in either theme.
 */
export default function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={clsx("botcord-brand-mark inline-block shrink-0", className)}
    />
  );
}
