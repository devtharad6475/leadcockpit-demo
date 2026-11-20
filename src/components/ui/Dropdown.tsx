/**
 * 2026-08-02 (UX redesign Phase 1) — Dropdown / menu primitive.
 *
 * The "⋯" row-action menu, bulk-action menu, and filter overflow menu. These
 * need correct focus management (focus moves into the menu on open, returns to
 * the trigger on close), arrow-key navigation, Escape-to-close, and outside-
 * click dismissal — all of which are easy to get wrong by hand.
 *
 * Built on @radix-ui/react-dropdown-menu for the behavior layer; the visual
 * layer is our token-driven Tailwind style (matches Card / Modal).
 *
 * Usage:
 *   <Dropdown trigger={<Button variant="ghost" icon={MoreHorizontal} />}>
 *     <DropdownItem icon={Edit} onSelect={() => ...}>Edit</DropdownItem>
 *     <DropdownSeparator />
 *     <DropdownItem icon={Trash} tone="danger" onSelect={...}>Delete</DropdownItem>
 *   </Dropdown>
 */
"use client";
import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

export type DropdownProps = {
  /** The element that opens the menu (a Button, an icon button, etc.). */
  trigger: React.ReactNode;
  /** Align the menu to the start or end of the trigger. Default end. */
  align?: "start" | "center" | "end";
  children: React.ReactNode;
  className?: string;
};

export function Dropdown({ trigger, align = "end", children, className = "" }: DropdownProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          className={`z-50 min-w-[12rem] overflow-hidden rounded-lg border border-border-default bg-surface p-1 shadow-xl data-[state=open]:lc-pop-in ${className}`}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export type DropdownItemProps = {
  icon?: React.ComponentType<{ className?: string }>;
  /** danger renders the item in danger-fg (for delete/destroy actions). */
  tone?: "default" | "danger";
  onSelect?: (e: Event) => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
};

export function DropdownItem({
  icon: Icon,
  tone = "default",
  onSelect,
  disabled,
  children,
  className = "",
}: DropdownItemProps) {
  const toneClass =
    tone === "danger" ? "text-danger-fg focus:bg-danger-bg" : "text-foreground focus:bg-surface-tint";
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      disabled={disabled}
      className={`flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${toneClass} ${className}`}
    >
      {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
      <span className="truncate">{children}</span>
    </DropdownMenu.Item>
  );
}

export function DropdownSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-border-subtle" />;
}

/** A non-interactive label, used to group items (e.g. "Actions"). */
export function DropdownLabel({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenu.Label className="px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-muted">
      {children}
    </DropdownMenu.Label>
  );
}
