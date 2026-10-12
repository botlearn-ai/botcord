/**
 * [INPUT]: Native radio input attributes; caller provides label/fieldset
 * [OUTPUT]: Radio with shared accent, focus and disabled states
 * [POS]: UI form primitive, preserves native group keyboard behavior
 * [PROTOCOL]: Keep name/value/checked/onChange native
 */
import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { clsx } from "clsx";
const Radio = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(function Radio({ className, ...props }, ref) {
  return <input {...props} ref={ref} type="radio" className={clsx("h-4 w-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50", className)} />;
});
export default Radio;
