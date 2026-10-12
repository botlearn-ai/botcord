"use client";
/**
 * [INPUT]: Controlled text and native input attributes
 * [OUTPUT]: SearchInput with a shared search icon and Input styling
 * [POS]: UI search primitive; debounce and fetching belong to the caller
 * [PROTOCOL]: Keep the public API aligned with COMPONENTS.md
 */
import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { Search } from "lucide-react";
import { clsx } from "clsx";
import { Input } from "./Input";
export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> { label: string }
const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput({ label, className, ...props }, ref) {
  return <div className={clsx("relative", className)}>
    <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
    <Input {...props} ref={ref} type="search" aria-label={props["aria-label"] ?? label} className="pl-9" />
  </div>;
});
export default SearchInput;
