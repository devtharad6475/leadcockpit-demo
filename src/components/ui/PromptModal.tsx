/**
 * Stage A+ / Cluster 10b (2026-07-26, P2-16) — PromptModal primitive.
 *
 * Replaces `window.prompt()` calls in page.tsx. The native prompt():
 *   - Blocks the entire UI thread (poor UX)
 *   - Has no styling (clashes with the design system)
 *   - Can't be styled for accessibility
 *   - Doesn't work on some mobile browsers
 *   - Is gradually being deprecated in modern browsers
 *
 * This component wraps the existing `<Modal>` primitive (which already has
 * role=dialog, aria-modal, Escape-to-close, focus trap, body-scroll-lock) and
 * adds a labelled text input + OK/Cancel buttons. Same semantics as
 * window.prompt: returns the entered string via onSubmit, or null-equivalent
 * (no callback) when cancelled.
 *
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   <PromptModal open={open} title="Why reject?" label="Reason (optional)"
 *                defaultValue="" onClose={() => setOpen(false)}
 *                onSubmit={(value) => { doReject(value); setOpen(false); }} />
 *   <button onClick={() => setOpen(true)}>Reject</button>
 */
"use client";
import React, { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";

export type PromptModalProps = {
  open: boolean;
  onClose: () => void;
  /** The question to ask (Modal title). */
  title: string;
  /** Visible label above the input (accessibility — never placeholder-only). */
  label?: string;
  /** Pre-filled value. */
  defaultValue?: string;
  /** Placeholder text inside the input. */
  placeholder?: string;
  /** Called with the entered value when OK is clicked. NOT called on cancel. */
  onSubmit: (value: string) => void;
  /** OK button label; default "OK". */
  okLabel?: string;
  /** Treat an empty submission as valid (default true). Set false to require input. */
  allowEmpty?: boolean;
};

export function PromptModal({
  open,
  onClose,
  title,
  label,
  defaultValue = "",
  placeholder,
  onSubmit,
  okLabel = "OK",
  allowEmpty = true,
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset to default each time the modal opens (mirrors window.prompt behaviour).
  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      // Focus the input shortly after open so the user can type immediately.
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open, defaultValue]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value;
    if (!allowEmpty && !trimmed.trim()) return;
    onSubmit(trimmed);
  };

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <form onSubmit={handleSubmit} className="space-y-3">
        {label && (
          <label className="block">
            <span className="label">{label}</span>
            <input
              ref={inputRef}
              type="text"
              className="input mt-1"
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        )}
        {!label && (
          // Accessibility fallback: still render the input with an aria-label
          // (placeholder-as-label fails WCAG 1.3.1).
          <input
            ref={inputRef}
            type="text"
            className="input"
            aria-label={title}
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">{okLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}
