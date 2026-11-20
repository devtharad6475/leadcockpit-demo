/**
 * 2026-09-28 (M10) — the company's closed dates (holidays), edited inside
 * "Ticket handling" in Workspace settings. The reply-deadline clock does not
 * run on these days.
 *
 * "Add common Indian holidays" fills in a SUGGESTED list for a year
 * (src/lib/holiday-suggestions.ts). It is labelled as a suggestion to check:
 * festival dates move every year and differ by state. Nothing is closed until
 * the owner saves, and every date can be removed.
 */
"use client";
import React, { useState } from "react";
import { Button, Badge } from "@/components/ui";
import { CalendarPlus, X } from "lucide-react";
import { suggestedIndianHolidays, HOLIDAY_SUGGESTION_YEARS } from "@/lib/holiday-suggestions";

export type ClosedDate = { date: string; label?: string };

function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map((part) => parseInt(part, 10));
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function merge(current: ClosedDate[], added: ClosedDate[]): ClosedDate[] {
  const byDate = new Map(current.map((entry) => [entry.date, entry]));
  for (const entry of added) if (!byDate.has(entry.date)) byDate.set(entry.date, entry);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function ClosedDatesEditor({ value, onChange }: { value: ClosedDate[]; onChange: (next: ClosedDate[]) => void }) {
  const thisYear = new Date().getFullYear();
  const years = Array.from(new Set([thisYear, thisYear + 1, ...HOLIDAY_SUGGESTION_YEARS])).filter((y) => y >= thisYear).sort();
  const [year, setYear] = useState<number>(years[0] ?? thisYear);
  const [newDate, setNewDate] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = value.filter((entry) => entry.date >= today);
  const past = value.length - upcoming.length;

  function addSuggestions() {
    const { holidays, festivalDatesKnown } = suggestedIndianHolidays(year);
    const before = value.length;
    const next = merge(value, holidays);
    onChange(next);
    const added = next.length - before;
    setNote(
      `${added} suggested day${added === 1 ? "" : "s"} added for ${year}. These are suggestions — check each date against your own calendar and remove any day you stay open, then save.` +
        (festivalDatesKnown ? "" : ` Festival dates for ${year} are not in the list yet; add Diwali, Holi and the others yourself.`),
    );
  }

  function addOne() {
    if (!newDate) return;
    onChange(merge(value.filter((entry) => entry.date !== newDate), [{ date: newDate, ...(newLabel.trim() ? { label: newLabel.trim() } : {}) }]));
    setNewDate("");
    setNewLabel("");
  }

  return (
    <div className="border-t border-border-subtle pt-3">
      <p className="label">Closed days (holidays)</p>
      <p className="mt-1 text-xs text-muted">
        On these days the reply-deadline clock stops, the same as a day off. Nothing closes until you save.
      </p>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="holiday-year" className="text-xs text-muted">Year</label>
          <select
            id="holiday-year"
            className="mt-1 block rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm"
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value, 10))}
          >
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <Button size="sm" variant="secondary" icon={CalendarPlus} onClick={addSuggestions}>
          Add common Indian holidays for {year}
        </Button>
      </div>
      {note ? <p className="mt-2 rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-xs text-muted" role="status">{note}</p> : null}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="closed-date" className="text-xs text-muted">Another closed day</label>
          <input
            id="closed-date"
            type="date"
            className="mt-1 block rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
          />
        </div>
        <div className="min-w-0 flex-1">
          <label htmlFor="closed-date-label" className="text-xs text-muted">Name (optional)</label>
          <input
            id="closed-date-label"
            type="text"
            maxLength={80}
            placeholder="e.g. Stock-taking"
            className="mt-1 block w-full rounded-md border border-border-default bg-surface px-2 py-1.5 text-sm"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
        </div>
        <Button size="sm" variant="secondary" onClick={addOne} disabled={!newDate}>Add</Button>
      </div>

      {upcoming.length === 0 ? (
        <p className="mt-2 text-xs text-muted">No closed days coming up.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border-subtle rounded-md border border-border-subtle bg-surface">
          {upcoming.map((entry) => (
            <li key={entry.date} className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
              <span className="min-w-0 truncate">
                {formatDay(entry.date)}
                {entry.label ? <span className="text-muted"> · {entry.label}</span> : null}
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon={X}
                aria-label={`Remove ${entry.label || entry.date}`}
                onClick={() => onChange(value.filter((other) => other.date !== entry.date))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {past > 0 ? <p className="mt-1 text-xs text-muted"><Badge tone="neutral">{past}</Badge> past closed day{past === 1 ? "" : "s"} kept for older tickets.</p> : null}
    </div>
  );
}
