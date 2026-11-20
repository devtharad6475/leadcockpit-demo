/**
 * 2026-07-21 (M1) — EmptyState primitive.
 *
 * Replaces the existing terse `<Empty text="No leads found." />` with a
 * structured empty state: icon + heading + body + optional CTA slot.
 *
 * Per docs/UI-DESIGN.md: critical screens (Dashboard, Today, Tickets,
 * Orders) pass a CTA; secondary screens leave it null (less visual
 * noise).
 */
import React from "react";

export type EmptyStateProps = {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  /** Optional primary action — typically a <Button> to move forward. */
  action?: React.ReactNode;
  className?: string;
};

export function EmptyState({ icon: Icon, title, description, action, className = "" }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-md border border-dashed border-border-default bg-surface-muted p-8 text-center ${className}`}
    >
      {Icon && <Icon className="mb-3 h-8 w-8 text-muted" aria-hidden="true" />}
      {/* 2026-09-04 N-UX-49 — this was a <p>. On a screen whose whole content
          is an empty state (Help & Support with no tickets is the one the walk
          caught), that made a page with no heading at all: nothing for a
          sighted reader to scan to, and nothing in a screen reader's landmark
          list. The styling is unchanged, so no screen moves — it is the same
          words, correctly labelled as the section's title. */}
      <h2 className="font-semibold text-foreground">{title}</h2>
      {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
