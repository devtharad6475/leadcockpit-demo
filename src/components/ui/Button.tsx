/**
 * 2026-07-21 (M1) — Button primitive.
 *
 * The single source of truth for all buttons going forward. Replaces the
 * ~108 hand-typed `className="btn"` / `className="btn secondary"` strings
 * scattered through page.tsx. Variants + sizes are typed; loading state
 * disables + shows a spinner; an optional icon slot accepts any lucide
 * icon component.
 *
 * Existing `.btn` CSS class is preserved for back-compat during the
 * screen-by-screen migration. New screens use <Button>.
 */
import React from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary: "bg-surface text-foreground border border-border-default shadow-sm hover:bg-surface-muted",
  danger: "bg-danger-fg text-white hover:opacity-90",
  ghost: "bg-transparent text-primary hover:bg-surface-tint",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  /* 2026-08-05 M-P1-2: sm 32→36px, md 40→44px (WCAG 2.5.5).
     2026-09-28: sm is 44px on phones too (below the sm breakpoint), where it
     is pressed with a thumb, and stays 36px from sm up so dense desktop rows
     do not change. */
  sm: "h-11 sm:h-9 px-3 text-xs gap-1.5",
  md: "h-11 px-3.5 text-sm gap-2",
  lg: "h-12 px-5 text-base gap-2.5",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** When true, disables the button and shows a spinner. */
  loading?: boolean;
  /** Optional lucide icon component. */
  icon?: React.ComponentType<{ className?: string }>;
  /** Icon position; default left. */
  iconPosition?: "left" | "right";
  children?: React.ReactNode;
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon: Icon,
  iconPosition = "left",
  children,
  disabled,
  className = "",
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const classes = [
    "inline-flex items-center justify-center rounded-lg font-semibold transition-colors",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
    "disabled:opacity-55 disabled:cursor-not-allowed",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  ].join(" ");

  const iconEl = loading ? (
    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
  ) : Icon ? (
    <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />
  ) : null;

  return (
    <button
      type="button"
      className={classes}
      disabled={isDisabled}
      // F-UI-7 (2026-08-04 build-right audit): participate in the page-level
      // busy-lock. The Cluster 3 CSS rule `main[data-busy="true"]
      // button[data-busy-locked="true"]` was a dead rule because no component
      // ever set this attribute. The <Button> primitive is the action-button
      // chokepoint, so when a section's async sets `loading=true` (its own
      // local busy), this attribute activates the lock on this button. Combined
      // with the capture-phase guard update in page.tsx, this closes the
      // double-submit gap for section action buttons (Tickets status changes,
      // Commercial Cancel/Convert, etc.) that were outside the old `.btn`-only
      // selector. Section components pass `loading={busy}` to opt in.
      data-busy-locked={loading ? "true" : undefined}
      aria-busy={loading || undefined}
      {...rest}
    >
      {iconPosition === "left" && iconEl}
      {children}
      {iconPosition === "right" && iconEl}
    </button>
  );
}
