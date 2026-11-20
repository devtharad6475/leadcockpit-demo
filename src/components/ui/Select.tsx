/**
 * 2026-07-21 (M1) — Select primitive.
 *
 * Replaces the inline `<select className="input">` strings scattered
 * through page.tsx. Adds proper label association + consistent styling.
 * Pure pass-through to <select> — no behavioural changes.
 */
import React from "react";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SelectProps = {
  id?: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  /** Optional helper text shown below the select. */
  hint?: string;
};

export function Select({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  required,
  className = "",
  hint,
}: SelectProps) {
  const selectId = id || (label ? `select-${label.toLowerCase().replace(/\s+/g, "-")}` : undefined);
  return (
    <div className={className}>
      {label && (
        <label htmlFor={selectId} className="label">
          {label}
          {required && <span className="ml-0.5 text-danger-fg">*</span>}
        </label>
      )}
      <select
        id={selectId}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
