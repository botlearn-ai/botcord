"use client";
/**
 * [INPUT]: Native anchor props and shared Button visual variants
 * [OUTPUT]: Styled link retaining navigation, modified-click and target/rel semantics
 * [POS]: UI action navigation; use Button for actions without destinations
 * [PROTOCOL]: Styles share buttonStyles; do not replace links with router onClick buttons
 */
import Link from "next/link";
import { forwardRef } from "react";
import type { AnchorHTMLAttributes } from "react";
import { buttonStyles } from "./Button";
import type { ButtonSize, ButtonVariant } from "./Button";
export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}
const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(function LinkButton({ href, variant = "secondary", size = "md", className, ...props }, ref) {
  const classes = buttonStyles(variant, size, className);
  return href.startsWith("/") && !href.startsWith("//") ? <Link ref={ref} href={href} className={classes} {...props} /> : <a ref={ref} href={href} className={classes} {...props} />;
});
export default LinkButton;
