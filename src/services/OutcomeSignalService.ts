/**
 * OutcomeSignalService — record what actually happened after the system talked
 * to a customer (2026-09-28, CEO overnight: "a system that learns from what
 * actually happens"). Review 2026-09-27 §1, proposal 4.
 *
 * Signals are written at the places where the result happens, never guessed:
 *   order_placed    an order becomes confirmed (created confirmed, moved to
 *                   confirmed, or made from a quote)            — one per order
 *   quote_accepted  a quote moves to accepted                   — one per quote
 *   lead_won/lost   the lead's status becomes won / lost         — one per change
 *   opted_out       the customer asks not to be contacted        — one per customer
 *   complaint       a complaint ticket opens from their message  — one per ticket
 *   no_reply_14d    14 days after our last message, no answer    — one per message
 *                   (found by the daily routine)
 *
 * A complaint or an opt-out also runs the trial de-proving check
 * (AutoReplyTrialService.switchOffAfterBadResult).
 *
 * Recording never throws: it runs after the real action has already happened,
 * and a failed signal must not undo an order or lose a customer's opt-out.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AutoReplyLog, Lead, OutcomeSignal, OutcomeSignalKind, Order, Quote } from "@/lib/types";
import { switchOffAfterBadResult } from "@/services/AutoReplyTrialService";

/** What was sent in these days before a result is what the result is joined to. */
export const OUTCOME_LOOKBACK_DAYS = 14;
export const NO_REPLY_DAYS = 14;
const DAY_MS = 86_400_000;

export const POSITIVE_OUTCOMES: readonly OutcomeSignalKind[] = ["order_placed", "quote_accepted", "lead_won"];
export const NEGATIVE_OUTCOMES: readonly OutcomeSignalKind[] = ["lead_lost", "opted_out", "complaint", "no_reply_14d"];

/** A reply that really reached the customer: sent by the AI itself, or approved and not blocked/failed. */
export function replyReachedCustomer(log: AutoReplyLog): boolean {
  if (log.status === "auto_sent") return true;
  return log.status === "approved" && log.sendStatus !== "blocked" && log.sendStatus !== "failed";
}

/** Pure: the replies that reached the customer in the lookback window before `at`. */
export function repliesBefore(logsForLead: AutoReplyLog[], at: Date, days = OUTCOME_LOOKBACK_DAYS): AutoReplyLog[] {
  const from = at.getTime() - days * DAY_MS;
  return logsForLead.filter((log) => {
    if (!replyReachedCustomer(log)) return false;
    const when = Date.parse(log.createdAt || "");
    return Number.isFinite(when) && when >= from && when <= at.getTime();
  });
}

export type RecordOutcomeInput = {
  leadId: string;
  kind: OutcomeSignalKind;
  sourceId: string;
  at?: string;
  value?: number;
};

export async function recordOutcome(workspaceId: string, input: RecordOutcomeInput, repos: RepositoryBundle): Promise<OutcomeSignal | undefined> {
  try {
    if (!input.leadId) return undefined;
    const lead = await repos.lead.getLeadById(workspaceId, input.leadId);
    if (!lead) return undefined; // another company's customer, or gone
    const at = input.at ? new Date(input.at) : new Date();
    const related = repliesBefore(await repos.autoReplyLog.listByLead(workspaceId, lead.id), at).map((l) => l.id);
    const signal = await repos.outcomeSignal.create(workspaceId, {
      leadId: lead.id,
      kind: input.kind,
      at: at.toISOString(),
      value: typeof input.value === "number" && Number.isFinite(input.value) ? input.value : undefined,
      relatedReplyIds: related,
      sourceId: input.sourceId,
    });
    if (input.kind === "complaint" || input.kind === "opted_out") {
      await switchOffAfterBadResult(workspaceId, { leadId: lead.id, trigger: input.kind, at: at.toISOString() }, repos);
    }
    return signal;
  } catch (error) {
    console.warn(`[outcomes] could not record ${input.kind}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

const WON = new Set(["won", "closed_won"]);
const LOST = new Set(["lost", "closed_lost"]);

/** After a lead edit: won / lost / opted out, only on an actual change. */
export async function recordLeadChangeOutcome(workspaceId: string, before: Lead | undefined, after: Lead, repos: RepositoryBundle): Promise<void> {
  const was = before?.status || "";
  if (WON.has(after.status) && !WON.has(was)) await recordOutcome(workspaceId, { leadId: after.id, kind: "lead_won", sourceId: `lead_won:${after.id}:${after.updatedAt}` }, repos);
  if (LOST.has(after.status) && !LOST.has(was)) await recordOutcome(workspaceId, { leadId: after.id, kind: "lead_lost", sourceId: `lead_lost:${after.id}:${after.updatedAt}` }, repos);
  const optedOutNow = Boolean(after.doNotContact) || after.status === "do_not_contact";
  const optedOutBefore = Boolean(before?.doNotContact) || before?.status === "do_not_contact";
  if (optedOutNow && !optedOutBefore) await recordOptOut(workspaceId, after.id, repos);
}

/** One opt-out per customer, however many paths report it. */
export function recordOptOut(workspaceId: string, leadId: string, repos: RepositoryBundle) {
  return recordOutcome(workspaceId, { leadId, kind: "opted_out", sourceId: `dnc:${leadId}` }, repos);
}

export function recordComplaint(workspaceId: string, leadId: string, ticketId: string, repos: RepositoryBundle) {
  return recordOutcome(workspaceId, { leadId, kind: "complaint", sourceId: `ticket:${ticketId}` }, repos);
}

const PLACED = new Set(["confirmed", "in_progress", "partial_shipped", "shipped", "delivered"]);

/** An order counts as placed the first time it is confirmed (or beyond). */
export async function recordOrderOutcome(workspaceId: string, order: Order, repos: RepositoryBundle): Promise<void> {
  if (!order.leadId || !PLACED.has(order.status)) return;
  await recordOutcome(workspaceId, { leadId: order.leadId, kind: "order_placed", sourceId: `order:${order.id}`, at: order.confirmedAt || undefined, value: order.grandTotal }, repos);
}

export async function recordQuoteOutcome(workspaceId: string, quote: Quote, repos: RepositoryBundle): Promise<void> {
  if (!quote.leadId || quote.status !== "accepted") return;
  await recordOutcome(workspaceId, { leadId: quote.leadId, kind: "quote_accepted", sourceId: `quote:${quote.id}`, at: quote.acceptedAt || undefined, value: quote.grandTotal }, repos);
}

const TERMINAL = new Set(["do_not_contact", "not_interested", "lost", "closed_lost", "invalid", "duplicate", "won", "closed_won"]);

/**
 * Daily: customers we messaged at least NO_REPLY_DAYS ago who have not written
 * since. One signal per last message, dated NO_REPLY_DAYS after it (so the
 * message itself sits inside the 14-day lookback it is joined to).
 */
export async function recordNoReplyOutcomes(workspaceId: string, repos: RepositoryBundle, now: Date = new Date()): Promise<number> {
  let recorded = 0;
  for (const lead of await repos.lead.listLeads(workspaceId)) {
    if (!lead.lastContactedAt || lead.doNotContact || TERMINAL.has(lead.status)) continue;
    if (lead.lastInboundAt && lead.lastInboundAt >= lead.lastContactedAt) continue;
    const sent = Date.parse(lead.lastContactedAt);
    if (!Number.isFinite(sent) || now.getTime() - sent < NO_REPLY_DAYS * DAY_MS) continue;
    const sourceId = `no_reply:${lead.id}:${lead.lastContactedAt}`;
    const existing = await repos.outcomeSignal.listByWorkspace(workspaceId, { leadId: lead.id, kind: "no_reply_14d" });
    if (existing.some((s) => s.sourceId === sourceId)) continue;
    const signal = await recordOutcome(workspaceId, { leadId: lead.id, kind: "no_reply_14d", sourceId, at: new Date(sent + NO_REPLY_DAYS * DAY_MS).toISOString() }, repos);
    if (signal) recorded++;
  }
  return recorded;
}
