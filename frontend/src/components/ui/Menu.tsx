/**
 * [INPUT]: 依赖 @radix-ui/react-dropdown-menu、VI 颜色语义类（bg-surface-raised、text-danger…）、styles/ui-motion-interactive.css 的 .bc-popover 与 clsx
 * [OUTPUT]: 对外提供 Menu（默认导出，Radix Root）与 MenuTrigger / MenuContent / MenuItem / MenuLabel / MenuSeparator
 * [POS]: ui 交互原语（批次 2）；dashboard 下拉菜单统一从这里出，不再手写 DropdownMenu.Content 样式
 * [PROTOCOL]: 变更时更新此头部，然后检查 docs/brand/botcord-vi/COMPONENTS.md；样式规则以 VI.md §3、§8、§9 为准
 */
"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ComponentRef, ReactNode } from "react";
import { clsx } from "clsx";

const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export const MenuContent = forwardRef<
  ComponentRef<typeof DropdownMenu.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Content>
>(function MenuContent({ className, sideOffset = 6, align = "start", collisionPadding = 8, ...rest }, ref) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={collisionPadding}
        className={clsx(
          "bc-popover z-[70] min-w-40 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-surface-raised p-1",
          "max-h-[var(--radix-dropdown-menu-content-available-height)] text-text-primary shadow-[var(--bc-shadow-lg)]",
          className,
        )}
        {...rest}
      />
    </DropdownMenu.Portal>
  );
});

export interface MenuItemProps extends ComponentPropsWithoutRef<typeof DropdownMenu.Item> {
  icon?: ReactNode;
  /** Destructive action: rendered in text-danger. */
  danger?: boolean;
}

export const MenuItem = forwardRef<ComponentRef<typeof DropdownMenu.Item>, MenuItemProps>(function MenuItem(
  { icon, danger = false, className, children, ...rest },
  ref,
) {
  return (
    <DropdownMenu.Item
      ref={ref}
      className={clsx(
        "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none",
        "transition-colors duration-[var(--bc-duration-fast)] motion-reduce:transition-none",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        danger
          ? "text-danger data-[highlighted]:bg-danger-soft"
          : "text-text-primary data-[highlighted]:bg-surface-sunken",
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span aria-hidden className={clsx("inline-flex h-4 w-4 shrink-0 items-center justify-center", !danger && "text-text-secondary")}>
          {icon}
        </span>
      ) : null}
      {children}
    </DropdownMenu.Item>
  );
});

export const MenuLabel = forwardRef<
  ComponentRef<typeof DropdownMenu.Label>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Label>
>(function MenuLabel({ className, ...rest }, ref) {
  return (
    <DropdownMenu.Label
      ref={ref}
      className={clsx("px-2 pb-1 pt-1.5 text-xs font-medium text-text-tertiary", className)}
      {...rest}
    />
  );
});

export const MenuSeparator = forwardRef<
  ComponentRef<typeof DropdownMenu.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenu.Separator>
>(function MenuSeparator({ className, ...rest }, ref) {
  return <DropdownMenu.Separator ref={ref} className={clsx("-mx-1 my-1 h-px bg-border", className)} {...rest} />;
});

export default Menu;
