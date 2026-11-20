/**
 * 2026-08-02 (UX redesign Phase 1) — Avatar primitive.
 *
 * Renders an initials circle (or image when supplied). Used for contacts, deal
 * owners, team members, and the "current user" chip. Replaces the ad-hoc
 * `rounded-full` divs scattered through the SPA.
 *
 * Built on @radix-ui/react-avatar so image loading + fallback is handled
 * correctly (image error → fallback initials automatically). Token-driven
 * colors keep it consistent with Badge/Button.
 */
"use client";
import React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";

export type AvatarSize = "xs" | "sm" | "md" | "lg";

const SIZE_CLASS: Record<AvatarSize, string> = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-12 w-12 text-base",
};

export type AvatarProps = {
  /** Image URL. If omitted (or if it fails to load), initials render. */
  src?: string;
  /** Display name — used to derive initials and as alt text. */
  name?: string;
  /** Explicit initials override (when name is not a person, e.g. "Acme Corp"). */
  initials?: string;
  size?: AvatarSize;
  className?: string;
};

function deriveInitials(name?: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ src, name, initials, size = "sm", className = "" }: AvatarProps) {
  const label = initials ?? deriveInitials(name);
  return (
    <AvatarPrimitive.Root
      className={`inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-primary-tint align-middle font-semibold text-primary-strong ${SIZE_CLASS[size]} ${className}`}
      // aria-label on the Root isn't read by all SRs; the fallback image alt
      // + the visually-hidden text handle naming. We set a title for sighted hover.
      title={name}
    >
      {src && (
        <AvatarPrimitive.Image
          src={src}
          alt={name ? `${name}'s avatar` : "Avatar"}
          className="h-full w-full object-cover"
        />
      )}
      <AvatarPrimitive.Fallback className="leading-none">{label}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
