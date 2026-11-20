/**
 * 2026-07-21 (M1) — Textarea primitive.
 *
 * Replaces the inline `<textarea className="input">` strings scattered
 * through page.tsx. Adds proper label association + optional character
 * counter.
 */
import React from "react";

export type TextareaProps = {
  id?: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
  /** Show a "N / maxLength" counter when maxLength is set. */
  showCounter?: boolean;
  className?: string;
  hint?: string;
};

export function Textarea({
  id,
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
  disabled,
  required,
  maxLength,
  showCounter = false,
  className = "",
  hint,
}: TextareaProps) {
  const textareaId = id || (label ? `ta-${label.toLowerCase().replace(/\s+/g, "-")}` : undefined);
  return (
    <div className={className}>
      {label && (
        <label htmlFor={textareaId} className="label">
          {label}
          {required && <span className="ml-0.5 text-danger-fg">*</span>}
        </label>
      )}
      <textarea
        id={textareaId}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        required={required}
        maxLength={maxLength}
      />
      <div className="mt-1 flex justify-between gap-2">
        {hint ? <p className="text-xs text-muted">{hint}</p> : <span />}
        {showCounter && maxLength && (
          <p className="text-xs text-muted">
            {value.length} / {maxLength}
          </p>
        )}
      </div>
    </div>
  );
}
