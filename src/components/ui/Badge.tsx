/**
 * 2026-07-21 (M1) — Badge primitive.
 *
 * A coloured pill for status indicators. Driven by `tone` — callers
 * pass a semantic tone (success/warning/danger/info/neutral), not a raw
 * colour. This enforces consistency: a "needs review" badge is always
 * amber, an "approved" badge is always green, etc.
 *
 * Pair with the displayLabel map (M2) so the badge text comes from a
 * friendly label, not a raw snake_case code.
 */
import React from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const TONE_CLASSES: Record<BadgeTone, string> = {
  // 2026-09-25 — each tone gets its own outline: the fills alone were so pale
  // that a status pill disappeared on the grey sub-panels.
  neutral: "bg-surface-muted text-muted-2 ring-1 ring-inset ring-border-default",
  success: "bg-success-bg text-success-fg ring-1 ring-inset ring-success-border",
  warning: "bg-warning-bg text-warning-fg ring-1 ring-inset ring-warning-border",
  danger: "bg-danger-bg text-danger-fg ring-1 ring-inset ring-danger-border",
  info: "bg-info-bg text-info-fg ring-1 ring-inset ring-info-border",
};

export type BadgeProps = {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
};

export function Badge({ tone = "neutral", children, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
