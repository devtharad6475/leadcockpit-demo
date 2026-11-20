/**
 * 2026-07-21 (M1) — Card primitive.
 *
 * Replaces the bespoke panel-like boxes scattered through page.tsx.
 * Optional icon + title header. Optional action slot (for the right-
 * side of the header — e.g. a refresh button or a "view all" link).
 */
import React from "react";

export type CardProps = {
  title?: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Optional right-side header content (button, badge, etc.). */
  action?: React.ReactNode;
  /** Padding; default md (p-4). Use sm for tighter layouts. */
  padding?: "none" | "sm" | "md";
  children: React.ReactNode;
  className?: string;
};

const PADDING_CLASS = {
  none: "",
  sm: "p-3",
  md: "p-4",
};

export function Card({ title, icon: Icon, action, padding = "md", children, className = "" }: CardProps) {
  // 2026-08-31 (N-UI-8) — the title is a real <h2> again, styled identically so
  // nothing on any screen moves. This is the same fix already applied to Panel
  // (primitives.tsx, N-UI-5); Card was the other half of the same 2026-08-02
  // demotion and had the same consequence.
  //
  // That demotion solved a real problem — a lone Card echoing the page <h1> —
  // but paid for it on every screen built from several Cards: those screens
  // ended up with NO headings at all, so there is no scan hierarchy for a
  // sighted operator and no landmark list for a screen-reader user.
  //
  // It also broke a test that was right: full-button-coverage.spec.ts asks for
  // `getByRole("heading", { name: "Outreach consent" })`, which is exactly what
  // a section title should be. It had been failing since the demotion.
  //
  // A duplicated heading on a single-Card screen is a small redundancy. No
  // headings on a multi-Card screen is a broken document.
  const headingId = React.useId();
  return (
    <section aria-labelledby={title ? headingId : undefined} className={`rounded-xl border border-border-default bg-surface shadow-sm ring-1 ring-black/[0.03] ${className}`}>
      {(title || action) && (
        // 2026-09-25 — a tinted header band and an icon chip, so where one
        // section ends and the next begins is visible at a glance.
        <header className="flex items-center justify-between gap-2 rounded-t-xl border-b border-border-default bg-surface-muted px-4 py-3">
          <div className="flex items-center gap-2.5">
            {Icon && (
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-tint text-primary">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
            )}
            {title && <h2 id={headingId} className="font-semibold text-foreground">{title}</h2>}
          </div>
          {action && <div>{action}</div>}
        </header>
      )}
      <div className={PADDING_CLASS[padding]}>{children}</div>
    </section>
  );
}
