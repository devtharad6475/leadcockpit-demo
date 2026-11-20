/**
 * 2026-07-27 (Session 6 U-3) — ConfirmModal primitive.
 *
 * Replaces native window.confirm() for destructive/irreversible actions.
 * Audit S6 U-3 found 5 such sites (cancel order, convert quote, price-change
 * broadcast, kill-switch engage, auto-send turn-on) using the browser's native
 * confirm() — no focus trap, no Escape handling per the design system, not
 * styled, blocked by some popup blockers, screen-reader-unfriendly. The
 * codebase already had a Modal primitive + a PromptModal (for text input);
 * this is the confirm-dialog sibling.
 *
 * Pattern matches Modal: role="dialog" + aria-modal + Escape + focus trap +
 * body-scroll-lock. Caller passes `open`, `onConfirm`, `onClose`, `title`,
 * `confirmLabel`, `tone` ("danger" for destructive), and children (the body
 * explanation). disableDismiss defaults true so a destructive confirm can't
 * be escaped by clicking outside (the user must pick Confirm or Cancel).
 */
"use client";
import React from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";

export type ConfirmModalProps = {
  open: boolean;
  onConfirm: () => void;
  onClose: () => void;
  title: string;
  /** The Confirm button label. */
  confirmLabel?: string;
  /** The Cancel button label. */
  cancelLabel?: string;
  /** "danger" renders the Confirm button in the destructive style. */
  tone?: "default" | "danger";
  /** Disable outside-click/Escape close. Default true (force an explicit choice). */
  disableDismiss?: boolean;
  /**
   * F-UI-7 (2026-08-04 build-right audit): when true, the Confirm button shows
   * a spinner + is disabled (preventing a double-click double-fire on the
   * destructive action while the request is in flight). Callers pass their
   * section `busy` state. The Button primitive's `loading` also sets
   * `data-busy-locked` so the page-level capture-phase guard blocks stray clicks.
   */
  loading?: boolean;
  children?: React.ReactNode;
};

export function ConfirmModal({
  open,
  onConfirm,
  onClose,
  title,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  disableDismiss = true,
  loading = false,
  children,
}: ConfirmModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" disableDismiss={disableDismiss}>
      <div className="space-y-4">
        {children ? <div className="text-sm text-muted">{children}</div> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={loading}>{cancelLabel}</Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}
