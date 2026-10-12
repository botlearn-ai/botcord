"use client";

/**
 * [INPUT]: useAppStore 持久化的主题偏好与浏览器 document
 * [OUTPUT]: 对外提供轻量的明暗主题切换按钮，并同步 HTML theme 属性
 * [POS]: dashboard 侧栏的全局外观控制项
 */

import IconButton from "@/components/ui/IconButton";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { useAppStore } from "@/store/useAppStore";

function applyTheme(theme: "dark" | "light") {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = theme === "light" ? "#eef3f9" : "#08111f";
}

export default function ThemeToggle() {
  const locale = useLanguage();
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const [hydrated, setHydrated] = useState(() => useAppStore.persist.hasHydrated());
  const isLight = theme === "light";
  const label = isLight
    ? (locale === "zh" ? "切换到深色模式" : "Switch to dark mode")
    : (locale === "zh" ? "切换到浅色模式" : "Switch to light mode");

  useEffect(() => {
    const unsubscribe = useAppStore.persist.onFinishHydration(() => setHydrated(true));
    setHydrated(useAppStore.persist.hasHydrated());
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    applyTheme(theme);
  }, [hydrated, theme]);

  return (
    <IconButton label={label}
      type="button"
      onClick={() => setTheme(isLight ? "dark" : "light")}
      aria-label={label}
      aria-pressed={isLight}
      title={label}
      className="group relative"
    >
      <Sun
        aria-hidden="true"
        className={isLight
          ? "absolute h-4 w-4 rotate-0 scale-100 text-warning transition-all duration-300"
          : "absolute h-4 w-4 -rotate-90 scale-0 text-warning opacity-0 transition-all duration-300"}
      />
      <Moon
        aria-hidden="true"
        className={isLight
          ? "absolute h-4 w-4 rotate-90 scale-0 text-accent-text opacity-0 transition-all duration-300"
          : "absolute h-4 w-4 rotate-0 scale-100 text-accent-text transition-all duration-300"}
      />
      <span className="sr-only">{label}</span>
    </IconButton>
  );
}
