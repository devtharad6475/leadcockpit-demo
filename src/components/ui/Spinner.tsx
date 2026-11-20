/**
 * 2026-07-21 (M1) — Spinner primitive.
 *
 * Accessible loading indicator. Uses aria-label + role="status" so
 * screen readers announce "Loading". Pure CSS animation (no JS).
 */
import React from "react";
import { Loader2 } from "lucide-react";

export type SpinnerProps = {
  size?: "sm" | "md" | "lg";
  label?: string;
  className?: string;
};

const SIZE_CLASS = {
  sm: "h-3.5 w-3.5",
  md: "h-5 w-5",
  lg: "h-8 w-8",
};

export function Spinner({ size = "md", label = "Loading", className = "" }: SpinnerProps) {
  return (
    <span role="status" aria-label={label} className={`inline-flex items-center ${className}`}>
      <Loader2 className={`${SIZE_CLASS[size]} animate-spin text-primary`} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
