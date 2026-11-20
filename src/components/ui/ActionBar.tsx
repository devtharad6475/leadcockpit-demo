/**
 * 2026-09-28 — ActionBar: the row of buttons that finishes a task (Approve,
 * Save, Reject…).
 *
 * On a phone it sticks to the bottom of the screen, so the owner can read a
 * long reply or quote and still reach "Approve" with one thumb without
 * scrolling back to find it. The buttons share the row evenly, each at least
 * 44px tall. From the `lg` breakpoint up it is an ordinary inline row, so
 * desktop screens look exactly as before.
 *
 * Put the ONE primary action first; secondary actions follow.
 */
import React from "react";

export type ActionBarProps = {
  children: React.ReactNode;
  className?: string;
  /** Default true. False keeps the row inline on phones too (e.g. inside a modal). */
  stickyOnPhone?: boolean;
};

export function ActionBar({ children, className = "", stickyOnPhone = true }: ActionBarProps) {
  const phone = stickyOnPhone
    ? "sticky bottom-0 z-10 -mx-4 border-t border-border-default bg-surface/95 px-4 py-3 backdrop-blur pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
    : "";
  return (
    <div
      className={`flex flex-wrap items-center gap-2 max-lg:[&>button]:min-h-11 max-lg:[&>button]:flex-auto max-lg:[&>button]:whitespace-nowrap ${phone} ${className}`}
    >
      {children}
    </div>
  );
}
