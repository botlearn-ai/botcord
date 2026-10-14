"use client";

/**
 * [INPUT]: 依赖用户资料、待处理请求数与 i18n 文案渲染账户菜单，依赖 dashboard session store 提供 Human 资料
 * [OUTPUT]: 对外提供 AccountMenu 组件，承载桌面账户菜单和移动端更多菜单（发现、钱包、主题、语言），以及 Human 资料编辑和基础账户动作
 * [POS]: dashboard 左下角统一账户入口；Bot 管理移动到 My Bots
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import Button from "@/components/ui/Button";
import IconButton from "@/components/ui/IconButton";
import { useState } from "react";
import type { UserProfile } from "@/lib/types";
import Menu, { MenuTrigger, MenuContent, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import Avatar from "@/components/ui/Avatar";
import UnreadBadge from "@/components/ui/UnreadBadge";
import Badge from "@/components/ui/Badge";
import { Building2, Compass, Languages, LogIn, LogOut, MoreHorizontal, Moon, Pencil, Settings, Sun, Wallet } from "lucide-react";
import Link from "next/link";
import HumanProfileEditModal from "./HumanProfileEditModal";
import { useAppStore } from "@/store/useAppStore";
import { useLanguage } from "@/lib/i18n";
import { accountMenu } from "@/lib/i18n/translations/dashboard";
import { common } from "@/lib/i18n/translations/common";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useShallow } from "zustand/react/shallow";

interface AccountMenuProps {
  user: UserProfile | null;
  pendingRequests: number;
  onLogout: () => void;
  onLogin?: () => void;
}

function getAvatarSeed(user: UserProfile | null): string {
  const base = user?.display_name || user?.email || "U";
  return base.slice(0, 1).toUpperCase();
}

export default function AccountMenu({
  user,
  pendingRequests,
  onLogout,
  onLogin,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const locale = useLanguage();
  const setLanguage = useAppStore((state) => state.setLanguage);
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const t = accountMenu[locale];
  const tc = common[locale];
  const { human } = useDashboardSessionStore(useShallow((state) => ({
    human: state.human,
  })));

  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger asChild>
          <Button variant="secondary" size="sm"
            className="relative flex w-10 max-md:w-12 max-md:flex-col items-center justify-center"
            title={t.account}
            aria-label={locale === "zh" ? "账户与更多" : "Account and more"}
          >
            <span className="absolute inset-0 overflow-hidden rounded-[inherit] max-md:hidden">
              <Avatar kind="human" id={human?.human_id ?? user?.email ?? "account"} name={user?.display_name || user?.email || t.user} src={user?.avatar_url} size="md" />
            </span>
            <MoreHorizontal className="hidden h-5 w-5 max-md:block" />
            <span className="hidden mt-0.5 text-xs font-medium max-md:block">{locale === "zh" ? "更多" : "More"}</span>
            <span className="max-md:hidden absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-deep-black-light bg-neon-cyan" />
            {pendingRequests > 0 && <UnreadBadge count={pendingRequests} className="absolute -right-1 -top-1" />}
          </Button>
        </MenuTrigger>


          <MenuContent
            sideOffset={12}
            side="top"
            align="start"
            className="w-[300px]"
          >
            <div className="md:hidden border-b border-glass-border mb-1 pb-1">
              <MenuItem asChild >
                <Link href="/chats/explore"><Compass size={18} />{locale === "zh" ? "发现" : "Discover"}</Link>
              </MenuItem>
              <MenuItem asChild >
                <Link href="/chats/wallet"><Wallet size={18} />{locale === "zh" ? "钱包" : "Wallet"}</Link>
              </MenuItem>
              <MenuItem onSelect={(event) => { event.preventDefault(); setTheme(theme === "light" ? "dark" : "light"); }} >
                {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
                {locale === "zh" ? (theme === "light" ? "切换到深色模式" : "切换到浅色模式") : (theme === "light" ? "Switch to dark mode" : "Switch to light mode")}
              </MenuItem>
              <MenuItem onSelect={(event) => { event.preventDefault(); setLanguage(locale === "zh" ? "en" : "zh"); }} >
                <Languages size={18} />{locale === "zh" ? "语言：中文 / English" : "Language: English / 中文"}
              </MenuItem>
            </div>
            {onLogin ? (
              <MenuItem onSelect={onLogin} ><LogIn size={18} />{tc.login}</MenuItem>
            ) : <>
            <div className="relative mb-1 overflow-hidden rounded-2xl border border-glass-border bg-glass-bg px-3 py-3.5">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/14 to-transparent" />
              <div className="flex items-center gap-3">
                <Avatar kind="human" id={human?.human_id ?? user?.email ?? "account"} name={user?.display_name || user?.email || t.user} src={user?.avatar_url} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 flex-1 truncate text-[18px] font-semibold tracking-tight text-text-primary">
                      {user?.display_name || user?.email || t.user}
                    </p>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge tone="accent" >
                        Human
                      </Badge>
                      {human && (
                        <IconButton size="sm" label={locale === "zh" ? "编辑个人资料" : "Edit profile"}
                          type="button"
                          onClick={() => { setOpen(false); setEditProfileOpen(true); }}
                          title={locale === "zh" ? "编辑个人资料" : "Edit profile"}
                          className="flex items-center justify-center"
                        >
                          <Pencil className="h-3 w-3" />
                        </IconButton>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">
                    {locale === "zh" ? "个人账户" : "Personal account"}
                  </p>
                </div>
              </div>
            </div>

            {/* Identity switcher removed: user is always Human. Manage bots via /chats/bots. */}
            <MenuItem asChild >
              <Link href="/settings/spaces"><Building2 className="mr-2 h-4 w-4" />{locale === "zh" ? "空间与组织" : "Spaces & organizations"}</Link>
            </MenuItem>

            {user?.beta_admin && (
              <>
                <MenuSeparator  />
                <MenuItem
                  onClick={() => { window.location.href = "/admin"; }}

                >
                  <Settings className="mr-2 h-4 w-4" />
                  <span>{locale === "zh" ? "管理后台" : "Admin"}</span>
                </MenuItem>
              </>
            )}

            <MenuSeparator  />

            <MenuItem
              danger
              onClick={onLogout}

            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>{tc.logout}</span>
            </MenuItem>
            </>}
          </MenuContent>

      </Menu>

      {editProfileOpen && (
        <HumanProfileEditModal onClose={() => setEditProfileOpen(false)} />
      )}
    </>
  );
}
