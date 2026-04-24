"use client";

/**
 * [INPUT]: 依赖 react 的 useEffect/useRef/useState 维护本地输入与防抖计时器，依赖外部 onSearch 回调与 dashboard 搜索文案
 * [OUTPUT]: 对外提供带 300ms 防抖的 SearchBar 组件，把用户输入稳定地提交给上层查询逻辑
 * [POS]: dashboard 搜索输入原子组件，被 Explore、联系人、消息侧栏等场景复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useRef, useState } from "react";
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

  useEffect(() => () => clearTimeout(timerRef.current), []);

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
