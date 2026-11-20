/**
 * 2026-08-02 (UX redesign Phase 1) — Drawer / slide-over primitive.
 *
 * THE #1 CRM pattern (NN/g "Data Tables" — top-ranked master-detail pattern).
 * A drawer slides in from the right and keeps the list visible behind it, so the
 * operator retains context and can click the next record without re-navigating.
 * This beats Modal (hides adjacent rows) and expand-row/accordion (breaks
 * comparison) for record-detail surfaces — lead detail, deal inspector, etc.
 *
 * Built on @radix-ui/react-dialog for the behavior layer (focus trap, scroll
 * lock, Escape, aria) — same a11y guarantees as Modal, none of the hand-rolled
 * focus-trap risk. Visual layer is our token-driven Tailwind style.
 *
 * Caller passes `open` + `onClose`; children are the drawer body. Use the
 * optional <DrawerHeader> / <DrawerBody> / <DrawerFooter> helpers for the
 * standard layout, or compose freely.
 */
"use client";
import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export type DrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title (required for a11y — Radix warns if absent). */
  title?: string;
  /** Optional description for screen readers. */
  description?: string;
  /**
   * Width bucket. Default md (~480px). lg for rich record detail with tabs;
   * sm for quick inspect; xl for a near-full-screen master record.
   */
  size?: "sm" | "md" | "lg" | "xl";
  /** Disable close-on-overlay-click + Escape. For required-action flows. */
  disableDismiss?: boolean;
  children: React.ReactNode;
};

const WIDTH_CLASS: Record<NonNullable<DrawerProps["size"]>, string> = {
  sm: "w-full max-w-sm",
  md: "w-full max-w-md",
  lg: "w-full max-w-lg",
  xl: "w-full max-w-2xl",
};

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  size = "md",
  disableDismiss = false,
  children,
}: DrawerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-50 bg-black/40 data-[state=open]:lc-overlay-in data-[state=closed]:lc-overlay-out"
          // Clicking the overlay closes unless disableDismiss. Radix handles
          // this via onOpenChange only when the pointer-down target is the
          // overlay itself (it doesn't fire for content interactions).
          onClick={(e) => {
            if (disableDismiss) e.preventDefault();
          }}
        />
        <Dialog.Content
          className={`fixed right-0 top-0 z-50 flex h-full ${WIDTH_CLASS[size]} flex-col border-l border-border-default bg-surface shadow-2xl outline-none data-[state=open]:lc-drawer-in data-[state=closed]:lc-drawer-out`}
          onEscapeKeyDown={(e) => {
            if (disableDismiss) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (disableDismiss) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (disableDismiss) e.preventDefault();
          }}
        >
          {title && (
            <header className="flex items-start justify-between gap-3 border-b border-border-subtle px-4 py-4 sm:px-5">
              <div className="min-w-0">
                <Dialog.Title className="truncate text-base font-semibold text-foreground">
                  {title}
                </Dialog.Title>
                {description && (
                  <Dialog.Description className="mt-0.5 text-sm text-muted">
                    {description}
                  </Dialog.Description>
                )}
              </div>
              {!disableDismiss && (
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close panel"
                    className="-mr-2 -mt-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-muted hover:text-foreground sm:mr-0 sm:mt-0 sm:h-8 sm:w-8"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              )}
            </header>
          )}
          {/*
            When no title is supplied, Radix still needs a Title for a11y.
            Provide a visually-hidden one so screen readers announce something.
          */}
          {!title && (
            <Dialog.Title className="sr-only">Detail panel</Dialog.Title>
          )}
          {description ? null : <Dialog.Description className="sr-only">Record details and actions.</Dialog.Description>}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Scrollable body region. Padding tuned for record detail. */
export function DrawerBody({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex-1 overflow-y-auto px-4 py-4 sm:px-5 ${className}`}>{children}</div>
  );
}

/** Sticky footer for primary actions (Approve / Save / Send). */
export function DrawerFooter({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <footer
      // 2026-09-28 — wraps, so four buttons never push the panel sideways on a
      // phone; there each button shares its row. Desktop is unchanged.
      className={`flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle bg-surface-muted px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 max-sm:[&>button]:flex-auto max-sm:[&>button]:whitespace-nowrap ${className}`}
    >
      {children}
    </footer>
  );
}
