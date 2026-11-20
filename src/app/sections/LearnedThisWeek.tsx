/**
 * 2026-09-28 — "What the system learned this week", at the top of Needs you.
 *
 * Proposals only, each with its evidence: kinds of automatic reply the system
 * switched off after a bad result (and why), patterns found in real results,
 * and customers who usually reorder about now. Nothing here changes anything
 * by itself — the owner keeps or dismisses each one.
 */
"use client";
import React, { useCallback, useEffect, useState } from "react";
import { Badge, Button, Textarea } from "@/components/ui";
import { Check, ChevronDown, ChevronUp, Lightbulb, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { displayReplyClassification } from "@/lib/display-labels";
import type { AutoReplyPause, FollowUp, UnknownQuestion } from "@/lib/types";
import type { Runner } from "@/app/page";
import { workspaceId } from "@/app/page";

type LearnedThisWeek = {
  switchedOff: AutoReplyPause[];
  proposals: UnknownQuestion[];
  reorders: Array<FollowUp & { companyName?: string }>;
};

export function LearnedThisWeekCard({ run, onOpen, refreshKey }: { run: Runner; onOpen: (itemId: string) => void; refreshKey?: number }) {
  const [data, setData] = useState<LearnedThisWeek | null>(null);
  const [open, setOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setData(await api<LearnedThisWeek>("/api/learning/this-week"));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, refreshKey]);

  if (loadError) return (
    <section className="rounded-xl border border-border-default bg-surface p-4" data-testid="learned-this-week">
      <p role="alert" className="text-sm text-danger-fg">We could not load what the system learned this week. There may still be changes or suggestions that need your attention.</p>
      <Button className="mt-2" variant="secondary" loading={loading} onClick={() => void load()}>Retry</Button>
    </section>
  );
  if (loading) return <p role="status" className="text-sm text-muted">Loading what the system learned this week…</p>;
  if (!data) return null;
  const unseen = data.switchedOff.filter((p) => !p.seenAt);
  const total = data.switchedOff.length + data.proposals.length + data.reorders.length;
  if (total === 0) return null;

  return (
    <section className="rounded-xl border border-border-default bg-surface" data-testid="learned-this-week">
      <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Lightbulb className="h-4 w-4 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold text-foreground">What the system learned this week</span>
        <span className="text-xs text-muted">{total} thing{total === 1 ? "" : "s"} to look at</span>
        {unseen.length ? <Badge tone="danger">{unseen.length} automatic repl{unseen.length === 1 ? "y" : "ies"} switched off</Badge> : null}
        {open ? <ChevronUp className="ml-auto h-4 w-4 text-muted" /> : <ChevronDown className="ml-auto h-4 w-4 text-muted" />}
      </button>
      {/* A switch-off is always shown, even collapsed: the owner must know. */}
      {(open ? data.switchedOff : unseen).length ? (
        <div className="space-y-2 border-t border-border-subtle px-4 py-3">
          {(open ? data.switchedOff : unseen).map((pause) => (
            <div key={pause.topic} className="rounded-lg border border-danger-border bg-danger-bg p-3">
              <div className="text-sm font-semibold text-danger-fg">
                The AI no longer answers {displayReplyClassification(pause.topic).toLowerCase()}s by itself
              </div>
              <p className="mt-1 text-sm text-foreground">{pause.reason}</p>
              <p className="mt-1 text-xs text-muted">
                These now wait for you, like before the trial. To switch it back on, review new drafts of this kind until the trial is passed again.
              </p>
              {!pause.seenAt ? (
                <Button className="mt-2" variant="secondary" icon={Check} onClick={() => run("Noted", async () => {
                  await api(`/api/whatsapp-agent/auto-reply-paused/${encodeURIComponent(pause.topic)}/seen`, { method: "POST", body: { workspaceId } });
                  await load();
                })}>Understood</Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="space-y-3 border-t border-border-subtle px-4 py-3">
          {data.proposals.map((q) => (
            <button key={q.id} type="button" className="block w-full rounded-lg border border-border-default bg-surface-muted p-3 text-left hover:bg-surface-tint" onClick={() => onOpen(`q:${q.id}`)}>
              <div className="text-sm font-semibold text-foreground">{q.questionText}</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-2">
                {q.generatedBy === "learned_from_outcomes"
                  ? q.suggestedAnswer
                  : `You corrected the AI's replies about this ${q.sourceIds?.length || "several"} times. Proposed answer: ${q.suggestedAnswer || ""}`}
              </p>
            </button>
          ))}
          {data.reorders.map((r) => (
            <button key={r.id} type="button" className="block w-full rounded-lg border border-border-default bg-surface-muted p-3 text-left hover:bg-surface-tint" onClick={() => onOpen(`r:${r.id}`)}>
              <div className="text-sm font-semibold text-foreground">{r.companyName || "A customer"} · {r.kind === "dormant" ? "has gone quiet" : "usually reorders about now"}</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-2">{r.evidence}</p>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * A pattern found in real results. The owner agrees by writing the guidance
 * in their own words (saved like any answer they give), or changes nothing.
 * Nothing is pre-filled: the numbers are evidence, not a rule.
 */
export function OutcomeProposalDetail({ question, run, onDone }: { question: UnknownQuestion; run: Runner; onDone: () => Promise<void> }) {
  const [guidance, setGuidance] = useState("");
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-bold tracking-tight text-foreground">{question.questionText}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-2">Learned from what actually happened with your customers. Nothing has been changed.</p>
      </div>
      <section className="rounded-xl border border-border-default bg-surface-muted p-4">
        <div className="text-xs font-bold uppercase tracking-wide text-muted">The evidence</div>
        <p className="mt-2 text-sm leading-relaxed text-foreground">{question.suggestedAnswer}</p>
        <p className="mt-2 text-xs text-muted">Based on {question.sourceIds?.length || 0} results.</p>
      </section>
      <section className="rounded-xl border border-border-default bg-surface p-4">
        <div className="text-sm font-semibold text-foreground">If you agree, tell the AI what to do differently</div>
        <Textarea className="mt-2" rows={3} value={guidance} onChange={setGuidance} placeholder="In your own words, e.g. “Send the shade card with every first catalogue reply.”" />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button icon={Check} disabled={!guidance.trim()} onClick={() => run("Saving your guidance", async () => {
            await api(`/api/unknown-questions/${question.id}/answer`, { method: "POST", body: { workspaceId, finalAnswer: guidance.trim(), addToKnowledge: true } });
            await onDone();
          })}>Save as guidance for the AI</Button>
          <Button variant="ghost" icon={X} onClick={() => run("Nothing changed", async () => {
            await api(`/api/unknown-questions/${question.id}`, { method: "PUT", body: { workspaceId, status: "ignored" } });
            await onDone();
          })}>Noted — change nothing</Button>
        </div>
      </section>
    </div>
  );
}
