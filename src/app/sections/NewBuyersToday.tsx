/**
 * 2026-09-28 — "Today's new buyers", at the top of Needs you.
 *
 * Only the new prospects worth the owner's time: found since yesterday,
 * scored good by the AI, reachable, not contacted yet (GET /api/new-buyers/today,
 * src/services/NewBuyersTodayService.ts — the same rule the morning summary
 * counts with). Approve / Not a fit call the existing lead review routes.
 * Nothing here sends anything to a buyer.
 */
"use client";
import React, { useCallback, useEffect, useState } from "react";
import { Badge, Button } from "@/components/ui";
import { Check, ChevronDown, ChevronUp, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { Runner, TabId } from "@/app/page";
import { workspaceId } from "@/app/page";

type NewBuyer = {
  leadId: string;
  name: string;
  score: number;
  scoreMax: number;
  reason: string;
  reachBy: string[];
  city?: string;
  foundAt: string;
  awaitingReview: boolean;
};

type NewBuyersToday = { items: NewBuyer[]; count: number };

export function NewBuyersTodayCard({
  run,
  onChanged,
  onFocusLead,
  refreshKey,
}: {
  run: Runner;
  onChanged: () => Promise<void>;
  onFocusLead?: (leadId: string, section: TabId) => void;
  refreshKey?: number;
}) {
  const [data, setData] = useState<NewBuyersToday | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api<NewBuyersToday>("/api/new-buyers/today"));
      setError(null);
    } catch {
      setData(null);
      setError("Today's new buyers could not be checked. Try refreshing the page.");
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, refreshKey]);

  if (error) return <p role="alert" className="rounded-xl border border-border-default bg-surface px-4 py-3 text-sm text-muted">{error}</p>;
  if (!data || data.count === 0) return null;

  async function decide(buyer: NewBuyer, approve: boolean) {
    await run(approve ? `${buyer.name} approved` : `${buyer.name} marked not a fit`, async () => {
      await api(`/api/leads/${buyer.leadId}/${approve ? "approve" : "reject"}`, {
        method: "POST",
        body: { workspaceId, ...(approve ? {} : { reason: "Not a fit (from Today's new buyers)" }) },
      });
      await load();
      await onChanged();
    });
  }

  return (
    <section className="rounded-xl border border-border-default bg-surface" data-testid="new-buyers-today">
      <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold text-foreground">Today&apos;s new buyers</span>
        <span className="text-xs text-muted">
          {data.count} good new buyer{data.count === 1 ? "" : "s"} found since yesterday
          {data.count > data.items.length ? ` · the best ${data.items.length} shown` : ""}
        </span>
        {open ? <ChevronUp className="ml-auto h-4 w-4 text-muted" /> : <ChevronDown className="ml-auto h-4 w-4 text-muted" />}
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border-subtle px-4 py-3">
          <p className="text-xs text-muted">Scored good by the AI, reachable, and nobody has contacted them yet. Nothing is sent to them from here.</p>
          {data.items.map((buyer) => (
            <div key={buyer.leadId} className="flex flex-wrap items-start gap-3 rounded-lg border border-border-default bg-surface-muted p-3">
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="text-left text-sm font-semibold text-foreground hover:underline"
                  onClick={() => onFocusLead?.(buyer.leadId, "crm")}
                >
                  {buyer.name}
                </button>
                {buyer.city ? <span className="ml-2 text-xs text-muted">{buyer.city}</span> : null}
                <p className="mt-1 text-xs leading-relaxed text-muted-2">{buyer.reason}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge tone="success">{buyer.score}/{buyer.scoreMax}</Badge>
                  {buyer.reachBy.map((r) => <Badge key={r} tone="neutral">{r}</Badge>)}
                  {!buyer.awaitingReview ? <Badge tone="info">Approved</Badge> : null}
                </div>
              </div>
              {buyer.awaitingReview ? (
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" icon={Check} onClick={() => void decide(buyer, true)}>Approve</Button>
                  <Button size="sm" variant="ghost" icon={X} onClick={() => void decide(buyer, false)}>Not a fit</Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
