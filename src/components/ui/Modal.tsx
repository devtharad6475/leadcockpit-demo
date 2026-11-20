/**
 * 2026-07-21 (M1) — Modal primitive.
 *
 * Replaces the bespoke modals in page.tsx (Simulate-Reply + Agent-
 * Instructions help). Both had different overlay/z-index/role handling;
 * one of them had no role/aria-modal/Escape/focus-trap. The audit
 * flagged this as an accessibility baseline failure.
 *
 * This primitive provides:
 *   - role="dialog" + aria-modal="true"
 *   - Escape-to-close (keyboard)
 *   - Click-outside-to-close
 *   - Body-scroll-lock while open
 *   - Focus moves to the modal on open; restores to trigger on close
 *   - Optional title + close button
 *
 * Caller passes `open` + `onClose`; children are the modal body.
 */
"use client";
import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Size; default md (~500px). lg for forms with many fields. */
  size?: "sm" | "md" | "lg" | "xl";
  children: React.ReactNode;
  /** Disable close-on-outside-click + Escape. For confirmations. */
  disableDismiss?: boolean;
};

const SIZE_CLASS = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export function Modal({ open, onClose, title, size = "md", children, disableDismiss = false }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Lock body scroll while open + restore on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Move focus into the modal.
    const focusable = dialogRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    return () => {
      document.body.style.overflow = originalOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open]);

  // Escape-to-close + Tab focus-trap (2026-07-26 Session 4 audit P3-PROMPTMODAL-1).
  // Pre-fix: Modal only did focus-MOVE on open + focus-RESTORE on close. A
  // keyboard user could Tab out of the modal into background content, violating
  // WCAG 2.4.3. Post-fix: Tab from the last focusable cycles to the first;
  // Shift+Tab from the first cycles to the last. The dialog is now a true focus
  // trap.
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disableDismiss) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null); // skip hidden
      if (focusables.length === 0) {
        // No focusable children — keep focus on the dialog itself.
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        // Shift+Tab from first → wrap to last.
        if (active === first || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        // Tab from last → wrap to first.
        if (active === last || !dialog.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, disableDismiss]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (!disableDismiss && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`max-h-[90vh] w-full ${SIZE_CLASS[size]} overflow-y-auto rounded-lg border border-border-default bg-surface shadow-xl outline-none`}
      >
        {title && (
          <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
            <h2 className="font-semibold text-foreground">{title}</h2>
            {!disableDismiss && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close dialog"
                className="rounded p-1 text-muted hover:bg-surface-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </header>
        )}
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
