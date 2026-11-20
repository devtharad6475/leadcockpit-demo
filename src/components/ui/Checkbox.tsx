/**
 * 2026-07-21 (M1) — Checkbox primitive.
 *
 * Replaces the inline `<input type="checkbox">` strings (e.g. the
 * consent checkbox in Onboarding). Proper label association + the
 * green primary colour when checked.
 */
import React from "react";

export type CheckboxProps = {
  id?: string;
  /** Optional visible label. When omitted, renders a bare checkbox — use
   *  aria-label on the Checkbox for accessibility (e.g. table row select). */
  label?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  /** Any other input attributes (aria-label, data-*, etc.) pass through. */
  "aria-label"?: string;
};

export function Checkbox({ id, label, checked, onChange, disabled, required, className = "", ...rest }: CheckboxProps) {
  // When no label is supplied, render a bare checkbox wrapped in a 44×44px
  // clickable hit area (2026-08-05 M-P1-3: the 16px visual was the only tap
  // target — 18% of the recommended area, severe on mobile). The visual stays
  // 16px; the wrapper makes the whole 44px region clickable.
  if (!label) {
    return (
      <label className={`inline-flex h-11 w-11 items-center justify-center ${disabled ? "opacity-55" : "cursor-pointer"} ${className}`}>
        <input
          id={id}
          type="checkbox"
          className="h-4 w-4 rounded border-border-default text-primary focus:ring-primary"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          required={required}
          {...rest}
        />
      </label>
    );
  }
  return (
    <label className={`inline-flex items-start gap-2 ${disabled ? "opacity-55" : ""} ${className}`}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-border-default text-primary focus:ring-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        required={required}
        {...rest}
      />
      <span className="text-sm text-foreground">{label}</span>
    </label>
  );
}
