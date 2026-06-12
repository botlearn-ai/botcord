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
import { animateIfMotion, cleanupAnime } from "@/lib/anime";

interface SearchBarProps {
  onSearch: (query: string) => void;
  placeholder?: string;
}

export default function SearchBar({ onSearch, placeholder }: SearchBarProps) {
  const locale = useLanguage();
  const t = searchBar[locale];
  const resolvedPlaceholder = placeholder || t.placeholder;
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const feedbackAnimationRef = useRef<ReturnType<typeof animateIfMotion>>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setValue(v);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSearch(v), 300);
  };

  const handleFocus = () => {
    const input = inputRef.current;
    if (!input) return;

    cleanupAnime(feedbackAnimationRef.current);
    feedbackAnimationRef.current = animateIfMotion(input, {
      boxShadow: [
        "0 0 0 rgba(34, 211, 238, 0)",
        "0 0 14px rgba(34, 211, 238, 0.18)",
        "0 0 0 rgba(34, 211, 238, 0)",
      ],
      duration: 420,
      ease: "out(3)",
    });
  };

  useEffect(() => () => {
    clearTimeout(timerRef.current);
    cleanupAnime(feedbackAnimationRef.current);
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={handleChange}
      onFocus={handleFocus}
      placeholder={resolvedPlaceholder}
      className="w-full rounded-lg border border-glass-border bg-deep-black-light px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 outline-none transition-colors focus:border-neon-cyan/50"
    />
  );
}
