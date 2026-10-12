/**
 * [INPUT]: Native select attributes and VI field tokens
 * [OUTPUT]: Select: native keyboard, form, validation and mobile picker semantics
 * [POS]: UI form primitive; rich option labels use SingleSelect instead
 * [PROTOCOL]: Keep the public API aligned with COMPONENTS.md
 */
import { forwardRef } from "react";
import type { SelectHTMLAttributes } from "react";
import { clsx } from "clsx";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> { invalid?: boolean }
const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ invalid, className, ...props }, ref) {
  return <select ref={ref} aria-invalid={invalid || undefined} className={clsx("liquid-input min-h-10 w-full rounded-lg px-3 py-2 text-sm text-text-primary outline-none disabled:cursor-not-allowed disabled:opacity-60", className)} {...props} />;
});
export default Select;
