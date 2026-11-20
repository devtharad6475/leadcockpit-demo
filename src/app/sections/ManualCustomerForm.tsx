"use client";
import { useState } from "react";
import { Button } from "@/components/ui";

export type ManualCustomerValues = { companyName: string; websiteUrl: string; email: string; phone: string; city: string; contactName: string; fitReason: string };
const empty: ManualCustomerValues = { companyName: "", websiteUrl: "", email: "", phone: "", city: "", contactName: "", fitReason: "" };
const fields: [keyof ManualCustomerValues, string][] = [["companyName", "Company Name"], ["websiteUrl", "Website URL"], ["email", "Email"], ["phone", "Phone / WhatsApp"], ["city", "City"], ["contactName", "Contact person"], ["fitReason", "Why they are a fit (optional)"]];

/** One existing manual-entry path, shared by Customers and Discovery. */
export function ManualCustomerForm({ onSave, onSaved, onCancel, saveLabel = "Save lead" }: { onSave: (values: ManualCustomerValues) => Promise<boolean | undefined>; onSaved: () => void; onCancel: () => void; saveLabel?: string }) {
  const [values, setValues] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return <form className="space-y-3" onSubmit={async event => {
    event.preventDefault();
    if (saving || !values.companyName.trim()) return;
    setSaving(true); setError("");
    try {
      const saved = await onSave(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])) as ManualCustomerValues);
      if (saved) onSaved();
      else setError("The customer was not saved. Your details are still here; check the error and try again.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The customer was not saved. Please try again."); }
    finally { setSaving(false); }
  }}>
    <div className="grid gap-3 sm:grid-cols-2">{fields.map(([key, label]) => <label key={key} className={key === "fitReason" ? "sm:col-span-2" : ""}>
      <span className="label">{label}</span>
      <input className="input" value={values[key]} disabled={saving} required={key === "companyName"} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} />
    </label>)}</div>
    <p className="text-xs text-muted">A company name is enough to save. Add the contact details you know. The phone number also identifies this customer when they message on WhatsApp. Saving does not contact anyone.</p>
    {error && <p role="alert" className="text-sm text-danger-fg">{error}</p>}
    <div className="flex gap-2"><Button type="submit" disabled={saving || !values.companyName.trim()}>{saving ? "Saving customer…" : saveLabel}</Button><Button type="button" variant="secondary" disabled={saving} onClick={onCancel}>Cancel</Button></div>
  </form>;
}
