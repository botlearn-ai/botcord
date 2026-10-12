"use client";

/**
 * [INPUT]: 依赖 react 的 useEffect/useRef/useState 维护本地输入与防抖计时器，依赖外部 onSearch 回调与 dashboard 搜索文案
 * [OUTPUT]: 对外提供带 300ms 防抖的 SearchBar 组件，把用户输入稳定地提交给上层查询逻辑，可即时通知查询展示状态
 * [POS]: dashboard 搜索输入原子组件，被 Explore、联系人、消息侧栏等场景复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { searchBar } from "@/lib/i18n/translations/dashboard";
import SearchInput from "@/components/ui/SearchInput";

interface SearchBarProps {
  onSearch: (query: string) => void;
  onInputChange?: (query: string) => void;
  placeholder?: string;
}

export default function SearchBar({ onSearch, onInputChange, placeholder }: SearchBarProps) {
  const locale = useLanguage();
  const resolvedPlaceholder = placeholder || searchBar[locale].placeholder;
  const [value, setValue] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return <SearchInput label={resolvedPlaceholder} placeholder={resolvedPlaceholder} value={value} onChange={(event) => {
    const next = event.target.value;
    setValue(next);
    onInputChange?.(next);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSearch(next), 300);
  }} />;
}
