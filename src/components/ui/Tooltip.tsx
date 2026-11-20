/**
 * 2026-08-02 (UX redesign Phase 1) — Tooltip primitive.
 *
 * Small hover/focus label for icon buttons, truncated cells, and status icons.
 * Replaces raw `title=""` attributes (which are inconsistent across browsers,
 * can't be styled, don't appear on touch, and disappear too fast to read).
 *
 * Built on @radix-ui/react-tooltip so positioning (flip when near viewport
 * edge), delay timing, and keyboard focus behavior are handled correctly.
 * The provider must wrap the app — it's added in layout.tsx alongside
 * ToastProvider.
 *
 * Usage:
 *   <Tooltip content="Approve and send to customer">
 *     <Button icon={Send} />
 *   </Tooltip>
 */
"use client";
import React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

export type TooltipProps = {
  /** The label shown in the tooltip. Keep it short (a phrase, not a paragraph). */
  content: React.ReactNode;
  /** Side relative to the trigger. Default top. */
  side?: "top" | "right" | "bottom" | "left";
  /** The element that triggers the tooltip on hover/focus (unused by the bare
   *  <Tooltip> content renderer; present only for API symmetry). */
  children?: React.ReactNode;
};

export function Tooltip({ content, side = "top", children }: TooltipProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        side={side}
        sideOffset={6}
        className="z-50 max-w-xs rounded-md border border-border-default bg-foreground px-2.5 py-1.5 text-xs font-medium text-surface shadow-lg data-[state=delayed-open]:lc-pop-in"
      >
        {content}
        <TooltipPrimitive.Arrow className="fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/**
 * Wrap the trigger + Tooltip together. Radix needs the Provider + Root + Trigger
 * structure; this helper composes them so callers don't have to. The trigger
 * must forward refs and accept data attributes — wrap custom components in
 * `asChild`-friendly elements (a native button/span works).
 */
export function TooltipWrapped({
  content,
  side = "top",
  children,
}: Omit<TooltipProps, "children"> & { children: React.ReactElement }) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <Tooltip content={content} side={side} />
    </TooltipPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;
