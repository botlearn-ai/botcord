"use client";

/**
 * [INPUT]: 依赖用户资料、待处理请求数与 i18n 文案渲染账户菜单，依赖 dashboard session store 提供 Human 资料
 * [OUTPUT]: 对外提供 AccountMenu 组件，承载用户头像菜单、Human 资料编辑与基础账户动作
 * [POS]: dashboard 左下角统一账户入口；Bot 管理移动到 My Bots
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState } from "react";
import type { UserProfile } from "@/lib/types";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { LogOut, Pencil, Settings } from "lucide-react";
import HumanProfileEditModal from "./HumanProfileEditModal";
import { useLanguage } from "@/lib/i18n";
import { accountMenu } from "@/lib/i18n/translations/dashboard";
import { common } from "@/lib/i18n/translations/common";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useShallow } from "zustand/react/shallow";

interface AccountMenuProps {
  user: UserProfile | null;
  pendingRequests: number;
  onLogout: () => void;
}

function getAvatarSeed(user: UserProfile | null): string {
  const base = user?.display_name || user?.email || "U";
  return base.slice(0, 1).toUpperCase();
}

export default function AccountMenu({
  user,
  pendingRequests,
  onLogout,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const locale = useLanguage();
  const t = accountMenu[locale];
  const tc = common[locale];
  const { human } = useDashboardSessionStore(useShallow((state) => ({
    human: state.human,
  })));

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-glass-border/80 bg-deep-black-light text-sm font-bold text-neon-cyan shadow-[0_10px_30px_rgba(0,0,0,0.28)] transition-all hover:-translate-y-0.5 hover:border-neon-cyan/35 hover:shadow-[0_14px_34px_rgba(34,211,238,0.18)] focus:outline-none focus:ring-2 focus:ring-neon-cyan/50"
            title={t.account}
          >
            <span className="absolute inset-0 overflow-hidden rounded-[inherit]">
              {user?.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.avatar_url}
                  alt={user.display_name || user.email || t.user}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.22),rgba(34,211,238,0.04)_58%,transparent_100%)]">
                  {getAvatarSeed(user)}
                </span>
              )}
            </span>
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-deep-black-light bg-neon-purple" />
            {pendingRequests > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-neon-purple px-1 text-[9px] font-bold text-black">
                {pendingRequests > 9 ? "9+" : pendingRequests}
              </span>
            )}
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            sideOffset={12}
            side="top"
            align="start"
            className="z-[70] min-w-[300px] overflow-hidden rounded-[24px] border border-glass-border/80 bg-[linear-gradient(180deg,rgba(16,18,26,0.96),rgba(10,12,18,0.98))] p-1.5 shadow-[0_28px_90px_rgba(0,0,0,0.55)] backdrop-blur-xl animate-in fade-in-80 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-100 data-[state=closed]:zoom-out-95"
          >
            <div className="relative mb-1 overflow-hidden rounded-[20px] border border-white/6 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.14),transparent_42%),linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))] px-3 py-3.5">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/14 to-transparent" />
              <div className="flex items-center gap-3">
                {user?.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.avatar_url}
                    alt={user.display_name || user.email || t.user}
                    className="h-12 w-12 shrink-0 rounded-2xl border border-white/10 object-cover shadow-[0_12px_30px_rgba(0,0,0,0.28)]"
                  />
                ) : (
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.28),rgba(34,211,238,0.08)_55%,rgba(255,255,255,0.02)_100%)] text-base font-semibold text-white shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
                    {getAvatarSeed(user)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 flex-1 truncate text-[18px] font-semibold tracking-tight text-white">
                      {user?.display_name || user?.email || t.user}
                    </p>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="inline-flex items-center rounded-full bg-neon-purple/10 px-2 py-0.5 text-[10px] font-medium text-neon-purple/75">
                        Human
                      </span>
                      {human && (
                        <button
                          type="button"
                          onClick={() => { setOpen(false); setEditProfileOpen(true); }}
                          title={locale === "zh" ? "编辑个人资料" : "Edit profile"}
                          className="flex h-5 w-5 items-center justify-center rounded-md text-text-secondary/50 transition-colors hover:bg-white/8 hover:text-neon-purple"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-text-secondary/78">
                    {locale === "zh" ? "个人账户" : "Personal account"}
                  </p>
                </div>
              </div>
              {human ? (
                <div className="mt-3 inline-flex max-w-full items-center rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1 text-[11px] text-text-secondary/68">
                  <span className="truncate" title={human.human_id}>
                    {human.human_id}
                  </span>
                </div>
              ) : null}
            </div>

            {/* Identity switcher removed: user is always Human. Manage bots via /chats/bots. */}

            {user?.beta_admin && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-glass-border" />
                <DropdownMenu.Item
                  onClick={() => { window.location.href = "/admin"; }}
                  className="relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors text-neon-purple focus:bg-neon-purple/10 focus:text-neon-purple"
                >
                  <Settings className="mr-2 h-4 w-4" />
                  <span>{locale === "zh" ? "管理后台" : "Admin"}</span>
                </DropdownMenu.Item>
              </>
            )}

            <DropdownMenu.Separator className="my-1 h-px bg-glass-border" />

            <DropdownMenu.Item
              onClick={onLogout}
              className="relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none transition-colors text-text-secondary focus:bg-red-500/10 focus:text-red-400"
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>{tc.logout}</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {editProfileOpen && (
        <HumanProfileEditModal onClose={() => setEditProfileOpen(false)} />
      )}
    </>
  );
}
