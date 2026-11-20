/**
 * 2026-08-17 — "Needs you" inbox.
 *
 * Source of the design: the claude.ai design project "Operator Dashboard UI
 * Redesign" (LeadCockpit Operator UI.dc.html, options 1b / 1c / 1d).
 *
 * The problem it solves: the AI runs on its own and the operator only shows
 * up when something is flagged. The shipped app answered that with a
 * Dashboard of counts plus 26 tabs — the operator lands and still has to
 * decide WHERE to go. This screen is the single queue: everything that is
 * genuinely waiting on a human, grouped by the four things that actually
 * stop the AI, answered in place one item at a time.
 *
 * The four groups (design 1b) map to real backend state — nothing here is
 * invented:
 *
 *   question — GET /api/unknown-questions   (status "open")
 *              The AI hit a knowledge gap and stopped rather than guess.
 *   money    — GET /api/quotes              (status "draft")
 *              A quote cannot leave without a confirmed price on every line.
 *   flag     — GET /api/auto-reply-logs     (held_for_review/blocked/failed/drafted)
 *              The AI wrote a reply and held it back.
 *   lead     — leads prop                   (reviewStatus "pending")
 *              A discovered prospect needs approve / reject.
 *
 * Design 1c (held reply + where each claim came from) is the `flag` detail
 * pane; design 1d (the quote price gate) is the `money` detail pane.
 *
 * Every action calls the same route the dedicated screen already calls, so
 * behaviour and audit trail are identical.
 *
 * 2026-09-28 — "Needs you" v2: the list and its count come from the server
 * (GET /api/needs-you, src/services/NeedsYouService.ts), the same list the
 * header count and the owner's morning summary use. New groups: customers
 * waiting for a reply, tickets due or late, orders to ship, quotes with no
 * answer.
 */
"use client";
import { formatDate, formatDateTime } from "@/lib/format-date";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionBar, Badge, Button, EmptyState, Spinner, Textarea } from "@/components/ui";
import {
  AlertTriangle, Bell, Check, ChevronLeft, ChevronRight, Clock, FileText, Gift, HelpCircle, Inbox, Layers3, Lock, MessageCircle, Package, ShoppingBag, Timer, X,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { formatINR, formatMoney } from "@/lib/money";
import { displayLabel, LEAD_SCORE_MAX, displayLeadSource, leadScoreText } from "@/lib/display-labels";
import { isAiScored } from "@/lib/lead-rules";
import type { AutoReplyLog, FollowUp, Lead, Order, Quote, Ticket, UnknownQuestion } from "@/lib/types";
import type { Runner, TabId } from "@/app/page";
import { workspaceId } from "@/app/page";
import { LearnedThisWeekCard, OutcomeProposalDetail } from "@/app/sections/LearnedThisWeek";
import { NewBuyersTodayCard } from "@/app/sections/NewBuyersToday";

// ─── Item model ────────────────────────────────────────────────────────────
// One shape for every row in the queue so the list renders uniformly and the
// detail pane switches on `bucket`.

type Bucket = "customer_waiting" | "ticket" | "question" | "money" | "flag" | "order" | "quote_waiting" | "reminder" | "festival" | "lead";

type FestivalCard = { key: string; name: string; date: string; daysAway: number; basis: "last_year_festival" | "last_12_months"; customers: Array<{ leadId: string; name: string }> };

type Chip = { text: string; tone: "danger" | "warning" | "neutral" };

/** One row, exactly as the server builds it (src/services/NeedsYouService.ts). */
type NeedItem = {
  id: string;
  bucket: Bucket;
  title: string;
  summary: string;
  /** ISO timestamp used for both the relative label and the sort. */
  at: string;
  chips: Chip[];
  question?: UnknownQuestion;
  quote?: Quote;
  log?: AutoReplyLog;
  lead?: Lead;
  reminder?: FollowUp;
  ticket?: Ticket;
  order?: Order;
  festival?: FestivalCard;
};

type NeedsYouResponse = {
  items: NeedItem[];
  count: number;
  counts: Record<Bucket, number>;
  setupBacklog: number;
  essentialBacklog: number;
};

/**
 * Group headings are written in the AI's own voice on purpose. "I stopped
 * myself" tells the operator what happened and who did it; "Held drafts"
 * (the old label) tells them neither.
 */
const BUCKETS: Array<{
  key: Bucket;
  heading: string;
  chip: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Tailwind text colour for the heading + icon. */
  accent: string;
  /** Left border on the selected row. */
  border: string;
}> = [
  // 2026-09-28 — Needs you v2: a customer or a deadline is waiting on these.
  { key: "customer_waiting", heading: "Customers waiting for a reply", chip: "Waiting", icon: Clock, accent: "text-danger-fg", border: "border-danger-fg" },
  { key: "ticket", heading: "Tickets due or late", chip: "Tickets", icon: Timer, accent: "text-danger-fg", border: "border-danger-fg" },
  { key: "question", heading: "The AI is asking you", chip: "Questions", icon: HelpCircle, accent: "text-primary", border: "border-primary" },
  { key: "money", heading: "Money needs your name on it", chip: "Money", icon: ShoppingBag, accent: "text-success-fg", border: "border-success-fg" },
  { key: "flag", heading: "I stopped myself", chip: "Flags", icon: AlertTriangle, accent: "text-danger-fg", border: "border-danger-fg" },
  { key: "order", heading: "Orders to ship", chip: "Orders", icon: Package, accent: "text-warning-fg", border: "border-warning-fg" },
  { key: "quote_waiting", heading: "Quotes with no answer", chip: "Quotes", icon: FileText, accent: "text-warning-fg", border: "border-warning-fg" },
  // 2026-09-27 — reminders for later: due today, or suggested from a customer's words.
  { key: "reminder", heading: "Reminders for today", chip: "Reminders", icon: Bell, accent: "text-warning-fg", border: "border-warning-fg" },
  // 2026-09-30 — a buying-season festival coming up.
  { key: "festival", heading: "Festivals coming up", chip: "Festivals", icon: Gift, accent: "text-primary", border: "border-primary" },
  { key: "lead", heading: "New leads outside your rules", chip: "Leads", icon: Layers3, accent: "text-muted", border: "border-muted" },
];

// Which rows count, which questions are "live" and which are the setup
// backlog is decided on the server now (NeedsYouService.isLiveQuestion), so
// the screen, the header and the morning summary can never disagree.

export function NeedsYou({
  run,
  reload,
  setActive,
  onFocusLead,
  onCount,
}: {
  run: Runner;
  reload: () => Promise<void> | void;
  setActive: (tab: TabId) => void;
  onFocusLead?: (leadId: string, section: TabId) => void;
  /** Lets the shell header render "N things need you" from the same count. */
  onCount?: (count: number) => void;
}) {
  const [data, setData] = useState<NeedsYouResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Bucket | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 2026-09-28 — phones get the queue and the item one after the other, not
  // side by side: the list first, then (after a tap) the item on its own with
  // a way back. From lg up both panes show together, as before.
  const [phoneShowsItem, setPhoneShowsItem] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setData(await api<NeedsYouResponse>("/api/needs-you"));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load()
        .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load your queue"))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  /** Re-read everything this screen shows after an action changes state. */
  async function refresh() {
    await load();
    await reload();
  }

  const items = useMemo<NeedItem[]>(() => data?.items || [], [data]);

  const visible = filter === "all" ? items : items.filter((i) => i.bucket === filter);

  /**
   * The onboarding backlog: open questions that came from the document
   * extractor rather than from live work. Shown as ONE row under the question
   * group with its true count, never as N rows in the queue. Q-7: of that, the
   * essential ones the AI is genuinely blocked on.
   */
  const setupBacklog = data?.setupBacklog || 0;
  const essentialBacklog = data?.essentialBacklog || 0;

  // Keep the shell header count in step with what this screen actually shows.
  useEffect(() => { if (data) onCount?.(data.count); }, [data, onCount]);

  // Selection is DERIVED, never synced into state: the operator's pick if it
  // is still in the list, otherwise the first row. Answering an item removes
  // it, and the pane falls through to the next one on its own.
  const selected = visible.find((i) => i.id === selectedId) || visible[0];
  const selectedIndex = selected ? visible.findIndex((i) => i.id === selected.id) : -1;

  function openItem(id: string) {
    setSelectedId(id);
    setPhoneShowsItem(true);
    // On a phone the item replaces the list, so start it at the top.
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) window.scrollTo({ top: 0 });
  }

  // ─── Keyboard: J / K move through the queue ──────────────────────────────
  // Design 1b promises "press J to skip". The listener is bound once, so it
  // reads the current list + position from a ref that an effect keeps fresh
  // (writing a ref during render would be a render-phase side effect).
  const navRef = useRef<{ list: NeedItem[]; currentId: string | undefined }>({ list: [], currentId: undefined });
  useEffect(() => {
    navRef.current = { list: visible, currentId: selected?.id };
  });
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Never steal J/K while the operator is writing an answer.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key !== "j" && key !== "k") return;
      const { list, currentId } = navRef.current;
      if (list.length === 0) return;
      event.preventDefault();
      const at = Math.max(0, list.findIndex((i) => i.id === currentId));
      const next = key === "j" ? Math.min(list.length - 1, at + 1) : Math.max(0, at - 1);
      setSelectedId(list[next].id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border-default bg-surface p-8 text-sm text-muted">
        <Spinner /> Reading everything that is waiting on you…
      </div>
    );
  }

  if (loadError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load your queue"
        description={loadError}
        action={<Button onClick={() => { setLoading(true); load().catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load")).finally(() => setLoading(false)); }}>Try again</Button>}
      />
    );
  }

  // 2026-09-28 — "What the system learned this week" sits above the queue.
  // 2026-09-28 — "Today's new buyers" (feature book #10) sits with it.
  const learnedCard = (
    <>
      <NewBuyersTodayCard run={run} refreshKey={items.length} onChanged={refresh} onFocusLead={onFocusLead} />
      <LearnedThisWeekCard run={run} refreshKey={items.length} onOpen={(id) => { setFilter("all"); setSelectedId(id); }} />
    </>
  );

  if (items.length === 0) {
    return (
      <div className="space-y-4">
      {learnedCard}
      <EmptyState
        icon={Check}
        title="Nothing needs you"
        description={
          setupBacklog > 0
            ? essentialBacklog > 0
              ? `The AI is handling everything it is allowed to handle. Nobody is waiting on you. Before it can answer confidently on its own, it still needs ${essentialBacklog} essential answer${essentialBacklog === 1 ? "" : "s"} about your business — about ${Math.max(1, Math.round(essentialBacklog / 4))} minute${Math.max(1, Math.round(essentialBacklog / 4)) === 1 ? "" : "s"} of your time.`
              : `The AI is handling everything it is allowed to handle. Nobody is waiting on you. The essentials are all answered; there are ${setupBacklog} deeper setup questions left that would make it better at every conversation.`
            : "The AI is handling everything it is allowed to handle. Anything it cannot answer, cannot price, or does not trust itself to send will appear here."
        }
        action={
          setupBacklog > 0
            ? <Button variant="secondary" onClick={() => setActive("unknown")}>{essentialBacklog > 0 ? "Answer the setup essentials" : "Work through the setup questions"}</Button>
            : <Button variant="secondary" onClick={() => setActive("dashboard")}>See the numbers instead</Button>
        }
      />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {learnedCard}
      {/* The "N things need you" headline lives in the shell header (page.tsx)
          so it sits on the same line as the workspace name — repeating it here
          would give the operator the same number twice. */}
      {/* Filter chips — same counts, one click to narrow. */}
      <div className={`flex flex-wrap gap-2 ${phoneShowsItem ? "max-lg:hidden" : ""}`}>
        <FilterChip active={filter === "all"} onClick={() => { setFilter("all"); setPhoneShowsItem(false); }} label={`All ${items.length}`} />
        {BUCKETS.map((b) => {
          const count = items.filter((i) => i.bucket === b.key).length;
          if (count === 0) return null;
          return <FilterChip key={b.key} active={filter === b.key} onClick={() => { setFilter(b.key); setPhoneShowsItem(false); }} label={`${b.chip} ${count}`} />;
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)] lg:items-start">
        {/* ── Left: the queue ── */}
        <div className={`overflow-hidden rounded-xl border border-border-default bg-surface lg:sticky lg:top-24 lg:max-h-[calc(100vh-9rem)] lg:overflow-y-auto ${phoneShowsItem ? "max-lg:hidden" : ""}`}>
          {BUCKETS.map((bucket) => {
            const rows = visible.filter((i) => i.bucket === bucket.key);
            // The question group still renders when it holds no live questions
            // but the setup backlog is non-empty — that row is its only child.
            const showBacklogRow = bucket.key === "question" && setupBacklog > 0 && (filter === "all" || filter === "question");
            if (rows.length === 0 && !showBacklogRow) return null;
            const Icon = bucket.icon;
            return (
              <div key={bucket.key}>
                <div className="flex items-center gap-2 border-y border-border-subtle bg-surface-muted px-4 py-2">
                  <Icon className={`h-3.5 w-3.5 ${bucket.accent}`} aria-hidden="true" />
                  <span className={`text-xs font-bold uppercase tracking-wide ${bucket.accent}`}>{bucket.heading}</span>
                  <span className="text-xs font-semibold text-muted">{rows.length}</span>
                </div>
                {rows.map((item) => {
                  const isActive = selected?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => openItem(item.id)}
                      aria-current={isActive ? "true" : undefined}
                      className={`block w-full border-b border-border-subtle border-l-[3px] px-4 py-3 text-left transition-colors ${isActive ? `${bucket.border} bg-surface-tint` : "border-l-transparent hover:bg-surface-muted"}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">{item.title}</span>
                        <span className="shrink-0 text-xs text-muted">{relativeTime(item.at)}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-2">{item.summary}</p>
                      {item.chips.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {item.chips.map((chip) => (
                            <Badge key={chip.text} tone={chip.tone === "neutral" ? "neutral" : chip.tone}>{chip.text}</Badge>
                          ))}
                        </div>
                      )}
                    </button>
                  );
                })}
                {showBacklogRow && (
                  <button
                    type="button"
                    onClick={() => setActive("unknown")}
                    className="block w-full border-b border-border-subtle border-l-[3px] border-l-transparent bg-surface-muted/60 px-4 py-3 text-left transition-colors hover:bg-surface-muted"
                  >
                    <div className="text-sm font-semibold text-foreground">
                      {essentialBacklog > 0
                        ? `${essentialBacklog} essential setup question${essentialBacklog === 1 ? "" : "s"} still unanswered`
                        : `${setupBacklog} setup question${setupBacklog === 1 ? "" : "s"} still unanswered`}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-2">
                      {essentialBacklog > 0
                        ? `Start here: these are the answers the AI needs before it can reply on its own. ${setupBacklog - essentialBacklog} deeper question${setupBacklog - essentialBacklog === 1 ? "" : "s"} can wait. Open the Questions screen →`
                        : "Gaps the AI found in your uploaded documents. Nobody is waiting on these — work through them when you have time and the AI gets better at every conversation. Open the Questions screen →"}
                    </p>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Right: answer it in place ── */}
        <div className={`min-w-0 ${phoneShowsItem ? "" : "max-lg:hidden"}`}>
          {/* Phone only: back to the list, and step through without it. */}
          <div className="mb-3 flex items-center justify-between gap-2 lg:hidden">
            <Button variant="ghost" icon={ChevronLeft} className="-ml-3" onClick={() => setPhoneShowsItem(false)}>
              All {visible.length}
            </Button>
            {selected && visible.length > 1 ? (
              <div className="flex items-center gap-1">
                <Button variant="secondary" icon={ChevronLeft} aria-label="Previous item" disabled={selectedIndex <= 0} onClick={() => openItem(visible[selectedIndex - 1].id)} />
                <Button variant="secondary" icon={ChevronRight} iconPosition="right" disabled={selectedIndex >= visible.length - 1} onClick={() => openItem(visible[selectedIndex + 1].id)}>
                  Next
                </Button>
              </div>
            ) : null}
          </div>
          {selected ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge tone={selected.bucket === "flag" || selected.bucket === "customer_waiting" || selected.bucket === "ticket" ? "danger" : selected.bucket === "money" ? "success" : "info"}>
                  {BUCKETS.find((b) => b.key === selected.bucket)?.heading}
                </Badge>
                <span className="text-xs text-muted">
                  Item {selectedIndex + 1} of {visible.length}
                  <span className="max-lg:hidden"> · press J to skip, K to go back</span>
                </span>
              </div>
              {selected.bucket === "question" && selected.question && selected.question.generatedBy === "learned_from_outcomes" && (
                <OutcomeProposalDetail key={selected.id} question={selected.question} run={run} onDone={refresh} />
              )}
              {selected.bucket === "question" && selected.question && selected.question.generatedBy !== "learned_from_outcomes" && (
                <QuestionDetail key={selected.id} question={selected.question} run={run} onDone={refresh} setActive={setActive} />
              )}
              {selected.bucket === "money" && selected.quote && (
                <QuoteGate key={selected.id} quote={selected.quote} lead={selected.lead} run={run} onDone={refresh} setActive={setActive} />
              )}
              {selected.bucket === "flag" && selected.log && selected.id.startsWith("u:") && (
                <UndeliveredReplyDetail key={selected.id} log={selected.log} lead={selected.lead} summary={selected.summary} run={run} onDone={refresh} setActive={setActive} />
              )}
              {selected.bucket === "flag" && selected.log && !selected.id.startsWith("u:") && (
                <HeldReplyDetail key={selected.id} log={selected.log} lead={selected.lead} run={run} onDone={refresh} setActive={setActive} />
              )}
              {selected.bucket === "festival" && selected.festival && (
                <FestivalDetail key={selected.id} festival={selected.festival} run={run} onDone={refresh} />
              )}
              {selected.bucket === "reminder" && selected.reminder && (
                <ReminderDetail key={selected.id} reminder={selected.reminder} lead={selected.lead} run={run} onDone={refresh} onFocusLead={onFocusLead} />
              )}
              {selected.bucket === "customer_waiting" && (
                <WaitingDetail key={selected.id} item={selected} setActive={setActive} onFocusLead={onFocusLead} />
              )}
              {selected.bucket === "ticket" && selected.ticket && (
                <TicketDueDetail key={selected.id} item={selected} ticket={selected.ticket} lead={selected.lead} setActive={setActive} />
              )}
              {selected.bucket === "order" && selected.order && (
                <OrderWaitingDetail key={selected.id} item={selected} order={selected.order} setActive={setActive} />
              )}
              {selected.bucket === "quote_waiting" && selected.quote && (
                <QuoteNoAnswerDetail key={selected.id} item={selected} quote={selected.quote} setActive={setActive} onFocusLead={onFocusLead} />
              )}
              {selected.bucket === "lead" && selected.lead && (
                <LeadDetail key={selected.id} lead={selected.lead} run={run} onDone={refresh} onFocusLead={onFocusLead} />
              )}
            </>
          ) : (
            <EmptyState icon={Inbox} title="Nothing in this filter" description="Pick another group above." />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Detail pane: a question the AI could not answer (design 1b right) ──────

/**
 * A conflict item is a CHOICE, and the two answers are on the record. Reading
 * them out of conflictSourcesJson is what lets the owner pick one instead of
 * retyping it.
 */
function conflictChoices(question: UnknownQuestion): Array<{ label: string; answer: string }> {
  const sources = question.conflictSourcesJson as
    | { existing?: { label?: unknown; answer?: unknown }; incoming?: { label?: unknown; answer?: unknown } }
    | undefined;
  if (!sources) return [];
  return [sources.existing, sources.incoming]
    .map((side, index) => ({
      label: typeof side?.label === "string" && side.label.trim() ? side.label : index === 0 ? "The approved answer" : "The new answer",
      answer: typeof side?.answer === "string" ? side.answer.trim() : "",
    }))
    .filter((side) => side.answer.length > 0);
}

/**
 * The stored draft carries a machine marker the backend reads
 * ("Framework question: product_varieties/minimum_quantities_by_variety.
 * Conflict: …"), which the screen printed as the owner's draft answer
 * (break test, 2026-09-26). Shown in plain words; `answer` is only the part
 * that is an actual proposed answer, if any.
 */
function readableDraft(stored?: string): { shown: string; answer: string } {
  const text = (stored || "").replace(/^Framework question: [^.\n]+\.\s*/, "").trim();
  const conflict = text.match(/^Conflict:\s*([\s\S]*)$/);
  if (conflict) return { shown: `Two sources disagree: ${conflict[1]}`, answer: "" };
  const partial = text.match(/^Partial source answer found, but owner clarification is still needed:\s*([\s\S]*)$/);
  if (partial) return { shown: `Found only part of it: ${partial[1]}`, answer: partial[1] };
  return { shown: text, answer: text };
}

function QuestionDetail({ question, run, onDone, setActive }: { question: UnknownQuestion; run: Runner; onDone: () => Promise<void>; setActive: (tab: TabId) => void }) {
  const choices = conflictChoices(question);
  const draft = readableDraft(question.suggestedAnswer);
  // Prefilling a conflict with the side-by-side sentence made "Save" write the
  // comparison itself — "Approved answer: ... New document answer: ..." — into
  // the knowledge base as the company's answer, keeping the wrong half. It
  // happened on the live demo, to six payment and credit answers, because the
  // default is the button an owner presses. A choice has no safe default.
  const [answer, setAnswer] = useState(choices.length ? "" : draft.answer);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-bold tracking-tight text-foreground">{question.questionText}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-2">
          Answer this once and the AI saves it to your knowledge base, replies to whoever is waiting, and stops asking.
        </p>
      </div>

      <section className="rounded-xl border border-border-default bg-surface-muted p-4">
        <div className="text-xs font-bold uppercase tracking-wide text-muted">What I already know</div>
        <div className="mt-3 space-y-2 text-sm text-muted-2">
          <KnownRow tone="ok" label="Where it came from">
            {question.generatedBy === "learned_from_corrections"
              ? `You corrected the AI's replies about this ${question.sourceIds?.length || "several"} times. This is what your versions kept saying — save it and the AI will use it.`
              : question.channel === "whatsapp" ? "A customer asked this on WhatsApp." : `Raised by ${question.generatedBy === "framework" ? "the onboarding question set" : question.generatedBy === "conflict_detection" ? "a conflict between two saved answers" : "the AI"}.`}
          </KnownRow>
          {question.missingTopic ? (
            <KnownRow tone="ok" label="Topic">{displayLabel(question.missingTopic)}</KnownRow>
          ) : null}
          {/* 2026-09-29 (walk-through NY6): when the two answers are offered as
              choices below, repeating them here mashed both into one line. */}
          {draft.shown && !choices.length ? (
            <KnownRow tone="ok" label={draft.answer ? "My draft answer" : "What I found"}>{draft.shown}</KnownRow>
          ) : null}
          <KnownRow tone="missing" label="Missing">
            A confirmed answer from you. That is the only reason I stopped.
          </KnownRow>
        </div>
      </section>

      {choices.length ? (
        <section className="rounded-xl border border-border-default bg-surface p-4">
          <div className="text-sm font-semibold text-foreground">Pick the one that is true</div>
          <p className="mt-1 text-xs text-muted-2">This goes into the knowledge base exactly as written, and the AI quotes it. Edit it below if neither is quite right.</p>
          <div className="mt-3 space-y-2">
            {choices.map((choice) => (
              <div key={choice.label} className="rounded-lg border border-border-default bg-surface-muted p-3">
                <div className="text-xs font-bold uppercase tracking-wide text-muted">{choice.label}</div>
                <p className="mt-1 text-sm leading-relaxed text-muted-2">{choice.answer}</p>
                <Button className="mt-2" variant="secondary" onClick={() => setAnswer(choice.answer)}>
                  Use this one
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-border-default bg-surface p-4">
        <div className="text-sm font-semibold text-foreground">Your answer</div>
        <Textarea
          className="mt-2"
          rows={4}
          value={answer}
          onChange={setAnswer}
          placeholder="Write it the way you would say it to the customer."
        />
      </section>
      <ActionBar>
          <Button
            icon={Check}
            disabled={!answer.trim()}
            onClick={() => run("Saving your answer", async () => {
              await api(`/api/unknown-questions/${question.id}/answer`, { method: "POST", body: { workspaceId, finalAnswer: answer.trim(), addToKnowledge: true } });
              await onDone();
            })}
          >
            Save and let the AI use it
          </Button>
          <Button
            variant="secondary"
            disabled={!answer.trim()}
            onClick={() => run("Saving draft only", async () => {
              await api(`/api/unknown-questions/${question.id}`, { method: "PUT", body: { workspaceId, suggestedAnswer: answer.trim() } });
              await onDone();
            })}
          >
            Save draft only
          </Button>
          <Button
            variant="ghost"
            onClick={() => run("Marking as not applicable", async () => {
              await api(`/api/unknown-questions/${question.id}`, { method: "PUT", body: { workspaceId, status: "ignored" } });
              await onDone();
            })}
          >
            Not applicable to us
          </Button>
      </ActionBar>
      <button type="button" className="min-h-11 text-sm font-medium text-primary hover:text-primary-hover lg:min-h-0 lg:text-xs" onClick={() => setActive("unknown")}>
        Open the full Questions screen →
      </button>
    </div>
  );
}

// ─── Detail pane: a held reply + where each claim came from (design 1c) ─────

/**
 * 2026-09-29 (owner walk-through R2) — an approved reply that never reached the
 * customer. The owner either sends it from their own phone and says so, or
 * opens the conversation. Nothing here sends anything.
 */
function UndeliveredReplyDetail({ log, lead, summary, run, onDone, setActive }: { log: AutoReplyLog; lead?: Lead; summary: string; run: Runner; onDone: () => Promise<void>; setActive: (tab: TabId) => void }) {
  const [copied, setCopied] = useState(false);
  const text = log.generatedReply || "";
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-bold tracking-tight text-foreground">
          {lead ? `Your reply to ${leadName(lead)} did not reach them` : "This reply did not reach the customer"}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-2">{summary}</p>
      </div>
      <section className="space-y-2 rounded-xl border border-border-default bg-surface p-4">
        {log.incomingMessage ? (
          <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-surface-muted px-3.5 py-2.5 text-sm text-foreground">{log.incomingMessage}</div>
        ) : null}
        <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-border-default bg-surface-tint px-3.5 py-2.5 text-sm text-foreground">
          {text || <span className="italic text-muted">No reply text was saved.</span>}
        </div>
      </section>
      <p className="text-sm text-muted-2">Send it from your own WhatsApp, then tell the system so it stops showing this customer as unanswered.</p>
      <ActionBar>
        <Button
          variant="secondary"
          disabled={!text}
          onClick={async () => {
            try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); }
          }}
        >
          {copied ? "Copied" : "Copy the reply"}
        </Button>
        <Button
          icon={Check}
          onClick={() => run("Marked as sent by you", async () => {
            await api(`/api/auto-reply-logs/${log.id}/sent-by-me`, { method: "POST", body: { workspaceId } });
            await onDone();
          })}
        >
          I sent it myself
        </Button>
        <Button variant="secondary" onClick={() => setActive("replies")}>Open conversation</Button>
      </ActionBar>
    </div>
  );
}

/**
 * 2026-09-30 — "Diwali is in 21 days": the customers who ordered before it
 * last year. The owner sets a reminder for each, or skips this year. Nothing
 * is sent to anyone.
 */
function FestivalDetail({ festival, run, onDone }: { festival: FestivalCard; run: Runner; onDone: () => Promise<void> }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-bold tracking-tight text-foreground">{festival.name} is on {formatDate(festival.date)}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-2">
          {festival.basis === "last_year_festival"
            ? `These customers ordered in the weeks before ${festival.name} last year. They may be stocking up again.`
            : `You have no orders from before ${festival.name} last year, so these are the customers who ordered from you in the last 12 months.`}
        </p>
      </div>
      <ul className="divide-y divide-border-subtle rounded-xl border border-border-default bg-surface">
        {festival.customers.map((c) => (
          <li key={c.leadId} className="px-4 py-2.5 text-sm text-foreground">{c.name}</li>
        ))}
      </ul>
      <p className="text-sm text-muted-2">
        A reminder is set for each of them two weeks before {festival.name}. Nothing is sent to any customer.
      </p>
      <ActionBar>
        <Button icon={Bell} onClick={() => run(`Reminders set for ${festival.name}`, async () => {
          await api(`/api/festivals/prompts/${festival.key}/remind`, { method: "POST", body: { workspaceId } });
          await onDone();
        })}>
          Remind me about them
        </Button>
        <Button variant="secondary" onClick={() => run("Skipped this year", async () => {
          await api(`/api/festivals/prompts/${festival.key}/skip`, { method: "POST", body: { workspaceId } });
          await onDone();
        })}>
          Not this year
        </Button>
      </ActionBar>
    </div>
  );
}

function HeldReplyDetail({ log, lead, run, onDone, setActive }: { log: AutoReplyLog; lead?: Lead; run: Runner; onDone: () => Promise<void>; setActive: (tab: TabId) => void }) {
  const context = (log.retrievedContext || {}) as Record<string, unknown>;
  const chunks = Array.isArray(context.chunks)
    ? (context.chunks as Array<{ id?: string; score?: number; documentTitle?: string }>)
    : [];
  const llmReason = typeof context.llmReason === "string" ? context.llmReason : "";
  const riskLevel = typeof context.llmRiskLevel === "string" ? context.llmRiskLevel : "";

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-bold tracking-tight text-foreground">
          {lead ? `I held my reply to ${leadName(lead)}` : "I held this reply"}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-2">
          Nothing was sent. Read it, then approve it or reject it.
        </p>
      </div>

      <section className="overflow-hidden rounded-xl border border-border-default bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border-subtle px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-bold text-muted-2">
              {(lead ? leadName(lead) : "?").charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 break-words text-sm font-semibold text-foreground">{lead ? leadName(lead) : "Unknown customer"}</span>
            <span className="text-xs text-muted">
              {displayLabel(log.channel)}
              {lead ? ` · ${isAiScored(lead) ? `score ${leadScoreText(lead)}` : "not scored yet"}` : ""}
            </span>
          </div>
          <button type="button" className="min-h-11 shrink-0 text-sm font-medium text-primary hover:text-primary-hover lg:min-h-0 lg:text-xs" onClick={() => setActive("replies")}>
            Open conversation →
          </button>
        </div>
        <div className="space-y-2 px-4 py-4">
          <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-surface-muted px-3.5 py-2.5 text-sm text-foreground">
            {log.incomingMessage}
          </div>
        </div>

        {/* The draft itself, framed as held — not as an outgoing message. */}
        <div className="mx-4 mb-4 overflow-hidden rounded-xl border border-danger-border">
          <div className="flex items-center gap-2 bg-danger-bg px-3.5 py-2.5">
            <AlertTriangle className="h-3.5 w-3.5 text-danger-fg" aria-hidden="true" />
            <span className="text-sm font-semibold text-danger-fg">{log.reason || "This draft needs a human decision"}</span>
          </div>
          <div className="bg-surface px-3.5 py-3 text-sm leading-relaxed text-foreground">
            {log.generatedReply || <span className="italic text-muted">No draft was generated.</span>}
          </div>
          <div className="border-t border-danger-border bg-surface px-3.5 py-3">
            <div className="text-xs font-bold uppercase tracking-wide text-muted">Where this draft came from</div>
            <div className="mt-2.5 space-y-2 text-sm text-muted-2">
              {log.retrievedContext?.source === "ticket_closure" ? (
                <div className="flex items-start gap-2.5">
                  <Badge tone="info" className="shrink-0 whitespace-nowrap">Team follow-up</Badge>
                  <div>Written by your team. Check it against the ticket&apos;s resolution and company policy before approving.</div>
                </div>
              ) : chunks.length > 0 ? (
                chunks.map((chunk, index) => (
                  <div key={chunk.id || index} className="flex items-start gap-2.5">
                    <Badge tone="success" className="shrink-0 whitespace-nowrap">Sourced</Badge>
                    <div>
                      {chunk.documentTitle || "Untitled knowledge document"}
                      {typeof chunk.score === "number" ? <span className="text-muted"> · match {(chunk.score * 100).toFixed(0)}%</span> : null}
                    </div>
                  </div>
                ))
              ) : (
                <div className="flex items-start gap-2.5">
                  <Badge tone="danger" className="shrink-0 whitespace-nowrap">No source</Badge>
                  <div>
                    Nothing in your knowledge base backed this draft. Every claim in it is the model&apos;s own wording — check it line by line before approving.
                  </div>
                </div>
              )}
              {llmReason ? (
                <div className="flex items-start gap-2.5">
                  <Badge tone="warning" className="shrink-0 whitespace-nowrap">Why I stopped</Badge>
                  <div>{llmReason}</div>
                </div>
              ) : null}
              {riskLevel ? (
                <div className="flex items-start gap-2.5">
                  <Badge tone="warning">Risk</Badge>
                  <div className="capitalize">{riskLevel.replace(/_/g, " ")}</div>
                </div>
              ) : null}
              {log.modelMode === "mock" ? (
                <div className="flex items-start gap-2.5">
                  <Badge tone="neutral" className="shrink-0 whitespace-nowrap">Sample mode</Badge>
                  <div>This draft came from the sample model, not a live one. Treat the wording as a placeholder.</div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <ActionBar>
        <Button
          icon={Check}
          disabled={!log.generatedReply}
          onClick={() => run("Approving the draft", async () => {
            await api(`/api/auto-reply-logs/${log.id}/approve`, { method: "POST", body: { workspaceId, body: log.generatedReply } });
            await onDone();
          })}
        >
          Approve this reply
        </Button>
        <Button
          variant="secondary"
          icon={X}
          onClick={() => run("Rejecting the draft", async () => {
            await api(`/api/auto-reply-logs/${log.id}/reject`, { method: "POST", body: { workspaceId } });
            await onDone();
          })}
        >
          Reject it
        </Button>
        <Button variant="ghost" icon={MessageCircle} onClick={() => setActive("replies")}>
          I&apos;ll write it myself
        </Button>
      </ActionBar>
    </div>
  );
}

// ─── Detail panes for the v2 groups (2026-09-28) ───────────────────────────
// Each says what is waiting and sends the owner to the screen where it is
// done. None of them sends anything to a customer.

function FactList({ facts }: { facts: Array<[string, string]> }) {
  return (
    <dl className="mt-3 divide-y divide-border-subtle text-sm">
      {facts.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="shrink-0 text-muted">{label}</dt>
          <dd className="text-right text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WaitingDetail({ item, setActive, onFocusLead }: { item: NeedItem; setActive: (tab: TabId) => void; onFocusLead?: (leadId: string, section: TabId) => void }) {
  return (
    <section className="rounded-xl border border-border-default bg-surface p-4">
      <h3 className="text-xl font-bold tracking-tight text-foreground">{item.title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-2">
        Their last message has had no reply for more than 2 working hours (your business hours).
      </p>
      <div className="mt-3 rounded-2xl rounded-bl-sm bg-surface-muted px-3.5 py-2.5 text-sm text-foreground">{item.summary}</div>
      <p className="mt-2 text-xs text-muted">Last message {relativeTime(item.at)}. Nothing is sent until you reply.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button icon={MessageCircle} onClick={() => setActive("replies")}>Reply now</Button>
        {item.lead && onFocusLead ? <Button variant="ghost" onClick={() => onFocusLead(item.lead!.id, "crm")}>Open the customer →</Button> : null}
      </div>
    </section>
  );
}

function TicketDueDetail({ item, ticket, lead, setActive }: { item: NeedItem; ticket: Ticket; lead?: Lead; setActive: (tab: TabId) => void }) {
  // "Late" is decided on the server, with the SLA engine, when the list is built.
  const late = item.chips.some((chip) => chip.text === "Late");
  return (
    <section className="rounded-xl border border-border-default bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xl font-bold tracking-tight text-foreground">Ticket #{ticket.ticketNumber}</h3>
        <Badge tone={late ? "danger" : "warning"}>{late ? "Late" : "Due today"}</Badge>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-2">{ticket.subject}</p>
      <FactList facts={[
        ["Customer", lead ? leadName(lead) : "Not linked"],
        ["Priority", ticket.priority.charAt(0).toUpperCase() + ticket.priority.slice(1)],
        ["Answer by", formatDateTime(ticket.slaDueAt)],
      ]} />
      <div className="mt-3"><Button onClick={() => setActive("tickets")}>Open the ticket</Button></div>
    </section>
  );
}

function OrderWaitingDetail({ item, order, setActive }: { item: NeedItem; order: Order; setActive: (tab: TabId) => void }) {
  return (
    <section className="rounded-xl border border-border-default bg-surface p-4">
      <h3 className="text-xl font-bold tracking-tight text-foreground">{item.title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-2">{item.summary}</p>
      <FactList facts={[
        ["Total", formatMoney(order.grandTotal, order.currencyCode)],
        ["Items", order.lineItems.map((line) => `${line.productName} × ${line.quantity} ${line.unit}`).join(", ") || "None listed"],
      ]} />
      <div className="mt-3"><Button onClick={() => setActive("commercial")}>Open the order</Button></div>
    </section>
  );
}

function QuoteNoAnswerDetail({ item, quote, setActive, onFocusLead }: { item: NeedItem; quote: Quote; setActive: (tab: TabId) => void; onFocusLead?: (leadId: string, section: TabId) => void }) {
  return (
    <section className="rounded-xl border border-border-default bg-surface p-4">
      <h3 className="text-xl font-bold tracking-tight text-foreground">{item.title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-2">{item.summary} A short follow-up often gets the answer — the AI can draft it for you.</p>
      <FactList facts={[["Total", formatMoney(quote.grandTotal, quote.currencyCode)]]} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => setActive("commercial")}>Open the quote</Button>
        {item.lead && onFocusLead ? <Button variant="ghost" onClick={() => onFocusLead(item.lead!.id, "crm")}>Open the customer →</Button> : null}
      </div>
    </section>
  );
}

// ─── Detail pane: the quote price gate (design 1d) ─────────────────────────

function QuoteGate({ quote, lead, run, onDone, setActive }: { quote: Quote; lead?: Lead; run: Runner; onDone: () => Promise<void>; setActive: (tab: TabId) => void }) {
  const unpriced = unpricedLines(quote);
  const blocked = unpriced.length > 0;

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-xl border border-border-default bg-surface">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-4 py-4">
          <div className="min-w-0">
            <h3 className="text-lg font-bold tracking-tight text-foreground">
              Quote #{quote.quoteNumber}{lead ? ` · ${leadName(lead)}` : ""}
            </h3>
            <p className="mt-0.5 text-xs text-muted">Draft quote · {relativeTime(quote.updatedAt || quote.createdAt)}</p>
          </div>
          <Badge tone={blocked ? "danger" : "success"}>{blocked ? "Cannot be sent yet" : "Ready for your name"}</Badge>
        </div>

        <div className="px-4 py-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="text-xs font-bold uppercase tracking-wide text-muted">
                  <th scope="col" className="pb-2 text-left">Item</th>
                  <th scope="col" className="pb-2 text-right">Qty</th>
                  <th scope="col" className="pb-2 text-right">Rate</th>
                  <th scope="col" className="pb-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {quote.lineItems.map((line) => {
                  const missing = !(line.unitPrice > 0);
                  return (
                    <tr key={line.id}>
                      <td className="py-2.5 pr-3 text-foreground">{line.productName}</td>
                      <td className="py-2.5 text-right text-muted-2">{line.quantity} {line.unit}</td>
                      <td className="py-2.5 text-right">
                        {missing ? (
                          <span className="inline-flex items-center rounded-lg border border-danger-fg bg-danger-bg px-2 py-1 text-xs font-semibold text-danger-fg">₹ —</span>
                        ) : (
                          formatINR(line.unitPrice)
                        )}
                      </td>
                      <td className={`py-2.5 text-right font-semibold ${missing ? "text-danger-fg" : "text-foreground"}`}>
                        {missing ? "—" : formatINR(line.lineTotal)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {blocked && (
            <div className="mt-4 rounded-lg border border-danger-border bg-danger-bg p-3.5">
              <div className="flex items-start gap-2.5">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" aria-hidden="true" />
                <p className="text-sm leading-relaxed text-danger-fg">
                  <strong>{unpriced.map((l) => l.productName).join(", ")}</strong>{" "}
                  {unpriced.length === 1 ? "has" : "have"} no rate. Nothing sends until you put a number on{" "}
                  {unpriced.length === 1 ? "it" : "each of them"} — that rule is not overridable, and the AI will not put a
                  guess in a quote.
                </p>
              </div>
              <div className="mt-3">
                <Button size="sm" variant="secondary" onClick={() => setActive("commercial")}>
                  Set the rate on this quote →
                </Button>
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-border-subtle pt-4">
            <div>
              <div className="text-xs text-muted">Total so far</div>
              <div className="text-2xl font-bold tracking-tight text-foreground">
                {formatINR(quote.grandTotal)}
                {blocked && (
                  <span className="ml-2 text-sm font-normal text-danger-fg">
                    + {unpriced.length} unpriced line{unpriced.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 max-lg:w-full max-lg:[&>button]:flex-1">
              <Button variant="secondary" onClick={() => setActive("commercial")}>Open in Quotes</Button>
              {/* Genuinely disabled, with the reason attached — not a button
                  that fails after the click. */}
              <Button
                icon={blocked ? Lock : Check}
                disabled={blocked}
                title={blocked ? "Every line needs a confirmed rate before this can be sent." : undefined}
                onClick={() => run("Marking the quote sent", async () => {
                  await api(`/api/quotes/${quote.id}/status`, { method: "POST", body: { toStatus: "sent" } });
                  await onDone();
                })}
              >
                Mark as sent
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ─── Detail pane: a discovered lead awaiting approve / reject ───────────────

function ReminderDetail({ reminder, lead, run, onDone, onFocusLead }: { reminder: FollowUp; lead?: Lead; run: Runner; onDone: () => Promise<void>; onFocusLead?: (leadId: string, section: TabId) => void }) {
  const suggested = reminder.status === "proposed";
  const fromOrders = reminder.source === "ai_proposed";
  const [dueOn, setDueOn] = useState(reminder.dueOn || "");
  return (
    <div className="rounded-lg border border-border-default bg-surface p-4">
      <p className="text-base font-medium">{reminder.note}</p>
      {lead ? <p className="mt-1 text-sm text-muted">{leadName(lead)}</p> : null}
      {reminder.evidence
        ? <p className="mt-2 text-sm text-muted-2">{fromOrders ? `From their order history: ${reminder.evidence}` : `The customer wrote: “${reminder.evidence}”`}</p>
        : null}
      <p className="mt-2 text-xs text-muted">
        {suggested && fromOrders
          ? "The system worked this out from the customer's past orders. Keep it with a date, or say it's not needed. Nothing is sent to the customer."
          : suggested
          ? "The AI noticed a time in the customer's message. Keep it with a date, or say it's not needed. Nothing is sent to the customer."
          : "Nothing is sent by itself — open the customer to reply; the AI drafts it for you."}
      </p>
      {suggested ? (
        <input type="date" className="input mt-3 text-sm sm:w-auto" aria-label="Date for this reminder" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
      ) : null}
      <ActionBar className="mt-3" stickyOnPhone={false}>
        {suggested ? (
          <>
            <Button variant="primary" icon={Check} disabled={!dueOn} onClick={() => run("Reminder kept", async () => { await api(`/api/follow-ups/${reminder.id}/confirm`, { method: "POST", body: { dueOn } }); await onDone(); })}>Keep this reminder</Button>
            <Button variant="ghost" icon={X} onClick={() => run("Reminder removed", async () => { await api(`/api/follow-ups/${reminder.id}/dismiss`, { method: "POST", body: {} }); await onDone(); })}>Not needed</Button>
          </>
        ) : (
          <Button variant="primary" icon={Check} onClick={() => run("Reminder done", async () => { await api(`/api/follow-ups/${reminder.id}/done`, { method: "POST", body: {} }); await onDone(); })}>Done</Button>
        )}
        {lead && onFocusLead ? <Button variant="ghost" onClick={() => onFocusLead(lead.id, "crm")}>Open the customer →</Button> : null}
      </ActionBar>
    </div>
  );
}

function LeadDetail({ lead, run, onDone, onFocusLead }: { lead: Lead; run: Runner; onDone: () => Promise<void>; onFocusLead?: (leadId: string, section: TabId) => void }) {
  const [rejectReason, setRejectReason] = useState("");
  const facts: Array<[string, string]> = [
    ["Industry", lead.industry || "Not captured"],
    ["Where", [lead.city, lead.state, lead.country].filter(Boolean).join(", ") || "Not captured"],
    ["Contact", [lead.contactName, lead.contactRole].filter(Boolean).join(" · ") || "Not captured"],
    ["Reachable on", [lead.whatsappNumber || lead.phone, lead.email].filter(Boolean).join(" · ") || "No phone or email found"],
    ["Found via", displayLeadSource(lead.source)],
  ];

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-bold tracking-tight text-foreground">{leadName(lead)}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-2">
          {lead.fitReason || lead.relevancyReason || "The AI found this prospect but will not contact anyone you have not approved."}
        </p>
      </div>

      <section className="rounded-xl border border-border-default bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={!isAiScored(lead) ? "neutral" : lead.leadScore >= LEAD_SCORE_MAX * 0.7 ? "success" : lead.leadScore >= LEAD_SCORE_MAX * 0.4 ? "warning" : "neutral"}>
            Score {leadScoreText(lead)}
          </Badge>
          {lead.doNotContact ? <Badge tone="danger">Do not contact</Badge> : null}
          {lead.buyerType ? <Badge tone="neutral">{lead.buyerType}</Badge> : null}
        </div>
        <dl className="mt-3 divide-y divide-border-subtle text-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="shrink-0 text-muted">{label}</dt>
              <dd className="min-w-0 break-words text-right text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded-xl border border-border-default bg-surface p-4">
        <label className="text-sm font-semibold text-foreground" htmlFor="needsyou-reject-reason">
          Reason, if you reject (optional)
        </label>
        <Textarea
          id="needsyou-reject-reason"
          className="mt-2"
          rows={2}
          value={rejectReason}
          onChange={setRejectReason}
          placeholder="Wrong region, too small, already a customer…"
        />
      </section>
      <ActionBar>
          <Button
            icon={Check}
            disabled={lead.doNotContact}
            title={lead.doNotContact ? "This lead is marked do-not-contact and cannot be approved." : undefined}
            onClick={() => run("Approving the lead", async () => {
              await api(`/api/leads/${lead.id}/approve`, { method: "POST", body: { workspaceId } });
              await onDone();
            })}
          >
            Approve
          </Button>
          <Button
            variant="secondary"
            icon={X}
            onClick={() => run("Rejecting the lead", async () => {
              await api(`/api/leads/${lead.id}/reject`, { method: "POST", body: { workspaceId, ...(rejectReason.trim() ? { reason: rejectReason.trim() } : {}) } });
              await onDone();
            })}
          >
            Reject
          </Button>
          {onFocusLead ? (
            <Button variant="ghost" onClick={() => onFocusLead(lead.id, "crm")}>Open the full record →</Button>
          ) : null}
      </ActionBar>
    </div>
  );
}

// ─── Small shared pieces ───────────────────────────────────────────────────

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-11 rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors lg:min-h-0 lg:px-3 lg:text-xs ${active ? "bg-foreground text-white" : "border border-border-default bg-surface text-muted-2 hover:bg-surface-muted"}`}
    >
      {label}
    </button>
  );
}

function KnownRow({ tone, label, children }: { tone: "ok" | "missing"; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${tone === "ok" ? "bg-success-fg" : "bg-danger-fg"}`} aria-hidden="true" />
      <div>
        <strong className="text-foreground">{label}:</strong> {children}
      </div>
    </div>
  );
}

function leadName(lead: Lead) {
  return lead.companyName || lead.contactName || "Unnamed prospect";
}

/** A line with no confirmed rate. This is the whole price gate in one place. */
function unpricedLines(quote: Quote) {
  return quote.lineItems.filter((line) => !(line.unitPrice > 0));
}

/**
 * "4m ago" / "3h" / "Yesterday". Deliberately coarse — the operator cares
 * whether a customer has been waiting minutes or days, not the exact clock.
 */
function relativeTime(iso: string) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return formatDate(then);
}
