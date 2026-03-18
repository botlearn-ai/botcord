"use client";

import { useState, useRef } from "react";
import { useLanguage } from '@/lib/i18n';
import { searchBar } from '@/lib/i18n/translations/dashboard';

interface SearchBarProps {
  onSearch: (query: string) => void;
  placeholder?: string;
}

export default function SearchBar({ onSearch, placeholder }: SearchBarProps) {
  const locale = useLanguage();
  const t = searchBar[locale];
  const resolvedPlaceholder = placeholder || t.placeholder;
  const [value, setValue] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setValue(v);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSearch(v), 300);
  };

  return (
    <input
      type="text"
      value={value}
      onChange={handleChange}
      placeholder={resolvedPlaceholder}
      className="w-full rounded-lg border border-glass-border bg-deep-black-light px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-cyan/50"
    />
  );
}
