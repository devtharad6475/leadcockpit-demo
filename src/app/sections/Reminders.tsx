/**
 * Reminders for later on one customer (2026-09-27). The owner sets "call after
 * Diwali" with a date; when a customer names a time in a message, the AI
 * proposes one with their words, and the owner confirms it with a date or
 * dismisses it. Only confirmed reminders count. Nothing is sent to the
 * customer by a reminder — on the day it shows in "Needs you".
 * Plan: docs/planning/DAILY-ROUTINE-AND-REMINDERS-PLAN.md §2.
 */
"use client";
import React, { useEffect, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { Bell, Check, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { FollowUp } from "@/lib/types";

function istToday(): string {
  return new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

function prettyDate(day?: string): string {
  if (!day) return "no date yet";
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function RemindersPanel({ leadId, doNotContact, readOnly = false }: { leadId: string; doNotContact?: boolean; readOnly?: boolean }) {
  const [items, setItems] = useState<FollowUp[]>([]);
  const [note, setNote] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [confirmDates, setConfirmDates] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const list = await api<FollowUp[]>(`/api/leads/${leadId}/follow-ups`);
    // Never let an unexpected answer take the whole customer screen down.
    setItems(Array.isArray(list) ? list : []);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "Couldn't load reminders."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  async function act(work: () => Promise<unknown>) {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const today = istToday();
  return (
    <div className="mt-3 border-t border-border-default pt-3" data-testid="reminders">
      <p className="flex items-center gap-1 text-xs text-muted"><Bell className="h-3.5 w-3.5" /> Reminders for later</p>
      {items.length === 0 ? <p className="mt-1 text-sm text-muted-2">No reminders.</p> : null}
      <ul className="mt-1 space-y-2">
        {items.map((f) => (
          <li key={f.id} className="rounded-md border border-border-default p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {f.status === "proposed"
                ? <Badge tone="info">Suggested</Badge>
                : f.dueOn && f.dueOn <= today ? <Badge tone="warning">Due</Badge> : <Badge tone="neutral">{prettyDate(f.dueOn)}</Badge>}
              <span className="min-w-0 break-words text-muted-2">{f.note}</span>
            </div>
            {f.evidence ? <p className="mt-1 text-xs text-muted">Customer wrote: “{f.evidence}”</p> : null}
            {!readOnly && <div className="mt-2 flex flex-wrap items-center gap-2">
              {f.status === "proposed" ? (
                <>
                  <input
                    type="date"
                    className="input text-sm sm:w-auto"
                    aria-label="Date for this reminder"
                    min={today}
                    value={confirmDates[f.id] ?? f.dueOn ?? ""}
                    onChange={(e) => setConfirmDates({ ...confirmDates, [f.id]: e.target.value })}
                  />
                  <Button size="sm" variant="secondary" icon={Check} disabled={busy || !(confirmDates[f.id] ?? f.dueOn)}
                    onClick={() => void act(() => api(`/api/follow-ups/${f.id}/confirm`, { method: "POST", body: { dueOn: confirmDates[f.id] ?? f.dueOn } }))}>
                    Keep this reminder
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" icon={Check} disabled={busy}
                  onClick={() => void act(() => api(`/api/follow-ups/${f.id}/done`, { method: "POST", body: {} }))}>
                  Done
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={X} disabled={busy}
                onClick={() => void act(() => api(`/api/follow-ups/${f.id}/dismiss`, { method: "POST", body: {} }))}>
                {f.status === "proposed" ? "Not needed" : "Remove"}
              </Button>
            </div>}
          </li>
        ))}
      </ul>
      {doNotContact ? (
        <p className="mt-2 text-xs text-muted">This customer asked not to be contacted, so new reminders can't be set.</p>
      ) : !readOnly ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api(`/api/leads/${leadId}/follow-ups`, { method: "POST", body: { note, dueOn } });
              setNote("");
              setDueOn("");
            });
          }}
        >
          <input
            className="input min-w-0 flex-1 text-sm"
            aria-label="What to do"
            placeholder="What to do — e.g. call about the Diwali order"
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <input type="date" className="input text-sm sm:w-auto" aria-label="When" min={today} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          <Button type="submit" size="sm" variant="secondary" icon={Bell} disabled={busy || !note.trim() || !dueOn}>
            Remind me
          </Button>
        </form>
      ) : null}
      {error ? <p className="mt-2 text-sm text-danger-fg">{error}</p> : null}
    </div>
  );
}
