/**
 * "How do you take your festivals?" (2026-09-30, CEO-approved plan
 * docs/planning/FESTIVAL-CALENDAR-PLAN.md part 2). Inside Workspace →
 * Working hours and holidays.
 *
 * The festival list comes from Google's public India holidays calendar
 * (FestivalCalendarService). For each festival the owner says whether the
 * company closes and for how many days around it; saving turns that into
 * closed days for this year and next, and the morning routine keeps next
 * year's dates up to date by itself. Hand-added closed days are never touched.
 */
"use client";
import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Checkbox } from "@/components/ui";
import { CalendarHeart } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/format-date";

type Rule = { key: string; closed: boolean; daysBefore: number; daysAfter: number; halfDay?: boolean; dispatchStops?: boolean };
type Upcoming = { key: string; name: string; date: string; tentative: boolean; rule?: Rule };
type View = { source: "google" | "built_in"; upcoming: Upcoming[]; rules: Rule[]; closedByRules: Array<{ date: string; label?: string }> };

const NUMBERS = Array.from({ length: 11 }, (_, n) => n);

export function FestivalRules({ onSaved }: { onSaved?: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [rules, setRules] = useState<Record<string, Rule>>({});
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function adopt(next: View) {
    setView(next);
    setRules(Object.fromEntries(next.rules.map((r) => [r.key, r])));
  }

  useEffect(() => {
    api<View>("/api/festivals").then(adopt).catch(() => setError("The festival list could not be loaded. Try again in a minute."));
  }, []);

  // The next 12 months, soonest first; rules the owner already set always show.
  const shown = useMemo(() => {
    if (!view) return [];
    const inAYear = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10);
    const list = view.upcoming.filter((f) => f.date <= inAYear || rules[f.key]?.closed);
    return showAll ? list : list.filter((f) => rules[f.key]?.closed || ["diwali", "holi", "dussehra", "navratri", "raksha_bandhan", "eid_ul_fitr", "ganesh_chaturthi", "christmas", "makar_sankranti", "pongal", "independence_day", "republic_day", "gandhi_jayanti", "bhai_dooj", "govardhan_puja", "janmashtami", "guru_nanak_jayanti", "onam", "durga_puja", "chhath_puja"].includes(f.key));
  }, [view, rules, showAll]);

  function update(key: string, patch: Partial<Rule>) {
    setRules((prev) => {
      const base: Rule = prev[key] ?? { key, closed: false, daysBefore: 0, daysAfter: 0 };
      return { ...prev, [key]: { ...base, ...patch } };
    });
    setNote(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const next = await api<View>("/api/festivals/rules", { method: "POST", body: { rules: Object.values(rules) } });
      adopt(next);
      const n = next.closedByRules.length;
      setNote(n ? `Saved. ${n} closed day${n === 1 ? "" : "s"} set for this year and next — they are in the list below. Next year's dates are added by themselves.` : "Saved. No festival closes your business.");
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The rules could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border-subtle bg-surface p-3" data-testid="festival-rules">
      <div className="flex items-start gap-2">
        <CalendarHeart className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-foreground">Festivals you close for</p>
          <p className="text-xs text-muted">
            Tick the festivals your business closes for, and how many days before and after. It repeats every year —
            the dates come from Google&apos;s calendar of Indian holidays{view?.source === "built_in" ? " (not reachable right now, so a saved list is shown)" : ""}.
          </p>
        </div>
      </div>
      {error ? <p className="text-sm text-danger-fg" role="alert">{error}</p> : null}
      {!view && !error ? <p className="text-sm text-muted">Loading the festival list…</p> : null}
      {view ? (
        <ul className="divide-y divide-border-subtle">
          {shown.map((f) => {
            const rule = rules[f.key];
            return (
              <li key={f.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
                <div className="min-w-44 flex-1">
                  <Checkbox label={<span className="font-medium">{f.name}</span>} checked={Boolean(rule?.closed)} onChange={(v) => update(f.key, { closed: v })} />
                  <span className="ml-6 block text-xs text-muted">{formatDate(f.date)}{f.tentative ? " (date may move by a day)" : ""}</span>
                </div>
                {rule?.closed ? (
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <label className="flex items-center gap-1.5">
                      <select className="rounded-md border border-border-default bg-surface px-1.5 py-1 text-sm" value={rule.daysBefore} onChange={(e) => update(f.key, { daysBefore: Number(e.target.value) })} aria-label={`Days closed before ${f.name}`}>
                        {NUMBERS.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                      days before
                    </label>
                    <label className="flex items-center gap-1.5">
                      <select className="rounded-md border border-border-default bg-surface px-1.5 py-1 text-sm" value={rule.daysAfter} onChange={(e) => update(f.key, { daysAfter: Number(e.target.value) })} aria-label={`Days closed after ${f.name}`}>
                        {NUMBERS.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                      days after
                    </label>
                    <Checkbox label="Half day only" checked={Boolean(rule.halfDay)} onChange={(v) => update(f.key, { halfDay: v })} />
                    <Checkbox label="Dispatch stops too" checked={Boolean(rule.dispatchStops)} onChange={(v) => update(f.key, { dispatchStops: v })} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {view ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} loading={busy}>Save festival days</Button>
          <Button variant="secondary" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show the main festivals" : "Show every festival"}</Button>
          {view.closedByRules.length ? <Badge tone="info">{view.closedByRules.length} closed days from these rules</Badge> : null}
        </div>
      ) : null}
      {note ? <p className="text-sm text-success-fg">{note}</p> : null}
      <p className="text-xs text-muted">Half-day festivals are worked, so reply deadlines keep running on them.</p>
    </div>
  );
}
