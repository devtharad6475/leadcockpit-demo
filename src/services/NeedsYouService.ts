/**
 * 2026-09-28 — "Needs you" v2: ONE list on the server.
 *
 * The screen, the header count and the morning summary all read this list, so
 * the number the owner sees on the phone is the number on the screen. Before,
 * the screen counted in the browser from four separate fetches and the header
 * showed a number only after the screen had been opened.
 *
 * Groups (docs/LOGIC.md NEEDS-YOU-V2):
 *   customer_waiting — a customer's last message has had no reply for more than
 *                      2 business hours (the company's own hours when set).
 *   ticket           — a ticket that is late, or due today (the SLA engine).
 *   question         — the AI stopped on a question a customer is waiting on.
 *   money            — a draft quote waiting for the owner.
 *   flag             — a reply the AI held back (owner only — only an owner can send it).
 *   order            — confirmed or partly shipped for more than 3 days.
 *   quote_waiting    — a quote sent more than 3 days ago with no answer.
 *   reminder         — reminders due today, and ones suggested from a customer's words.
 *   lead             — a found buyer waiting for approve / reject.
 *
 * Reads only. Nothing here sends anything.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AutoReplyLog, FollowUp, Lead, Order, Quote, Ticket, TicketSlaSettings, UnknownQuestion } from "@/lib/types";
import { computeSla, defaultTicketSlaSettings } from "@/lib/ticket-sla";
import { todayIstIsoDate } from "@/lib/time";
import { formatMoney } from "@/lib/money";
import { displayLabel, displayReplyClassification, leadScoreText } from "@/lib/display-labels";
import { isAiScored } from "@/lib/lead-rules";
import { computeLiveBreach } from "@/services/TicketService";
import { isEssentialSetupQuestion } from "@/services/KnowledgeQuestionPresentationService";
import { listDueReminders, listProposedReminders } from "@/services/FollowUpService";
import { replyDeliveryState } from "@/lib/reply-delivery-state";
import { closedDayMentions } from "@/lib/closed-day-mentions";
import { knowledgeAreaName } from "@/lib/knowledge-area-names";
import { formatDate } from "@/lib/format-date";
import { festivalPrompts, type FestivalPrompt } from "@/services/FestivalSeasonService";
import { isInternalSectionQuestion, isNewDetailQuestion, plainQuestionTitle, sameQuestionKey } from "@/lib/owner-question-text";
import { getWorkspaceChecklist } from "@/services/DocumentQuestionAnsweringService";

export const CUSTOMER_WAITING_BUSINESS_MINUTES = 120;
export const ORDER_WAITING_DAYS = 3;
export const QUOTE_NO_ANSWER_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type NeedsYouBucket =
  | "customer_waiting" | "ticket" | "question" | "money" | "flag" | "order" | "quote_waiting" | "reminder" | "festival" | "lead";

/** Screen order. */
export const NEEDS_YOU_BUCKETS: NeedsYouBucket[] = [
  "customer_waiting", "ticket", "question", "money", "flag", "order", "quote_waiting", "reminder", "festival", "lead",
];

export type NeedsYouChip = { text: string; tone: "danger" | "warning" | "neutral" };

export type NeedsYouItem = {
  id: string;
  bucket: NeedsYouBucket;
  title: string;
  summary: string;
  /** ISO time used for the "3h ago" label and the sort. */
  at: string;
  chips: NeedsYouChip[];
  leadId?: string;
  /** Rupee amount for money items (INR records only). */
  amountInr?: number;
  lead?: Lead;
  question?: UnknownQuestion;
  quote?: Quote;
  log?: AutoReplyLog;
  reminder?: FollowUp;
  ticket?: Ticket;
  order?: Order;
  /** 2026-09-30 — a buying-season festival coming up (FestivalSeasonService). */
  festival?: FestivalPrompt;
};

export type NeedsYouList = {
  items: NeedsYouItem[];
  /** THE count — the screen, the header and the morning summary all show this. */
  count: number;
  counts: Record<NeedsYouBucket, number>;
  /** Setup questions from the uploaded documents: shown as one row, never counted as interruptions. */
  setupBacklog: number;
  essentialBacklog: number;
  generatedAt: string;
};

const HELD_STATUSES = new Set(["held_for_review", "drafted", "failed", "blocked"]);
const LIVE_QUESTION_SOURCES = new Set(["whatsapp_unknown", "llm_suggested", "conflict_detection", "user", "learned_from_corrections", "learned_from_outcomes"]);
const CLOSED_LEAD_STATUSES = new Set<Lead["status"]>(["do_not_contact", "invalid", "duplicate", "not_interested", "lost", "closed_lost", "rejected"]);
const ORDER_WAITING_STATUSES = new Set<Order["status"]>(["confirmed", "in_progress", "partial_shipped"]);

/** A question a customer (or live work) is waiting on — not the onboarding backlog. */
export function isLiveQuestion(question: UnknownQuestion): boolean {
  if (question.generatedBy === "framework") return false;
  // 2026-09-29 (walk-through NY3): a disagreement inside the question bank's
  // own catch-all section is setup work (Knowledge screen), unless a customer
  // is actually waiting on it.
  if (isInternalSectionQuestion(question) && question.channel !== "whatsapp" && !question.leadId && !question.conversationId) return false;
  if (LIVE_QUESTION_SOURCES.has(question.generatedBy || "")) return true;
  return question.channel === "whatsapp" || Boolean(question.leadId) || Boolean(question.conversationId);
}

export function leadDisplayName(lead?: Lead): string {
  return lead?.companyName || lead?.contactName || "Unnamed customer";
}

/** How far back an approved-but-undelivered reply still needs the owner. */
export const UNDELIVERED_LOOKBACK_DAYS = 30;

/**
 * How long a customer has really waited, in words (walk-through NY2: a 35-day
 * wait read "No reply for over 2 working hours"). Calendar time, since that
 * is what the customer experienced.
 */
export function waitedFor(sinceIso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - ms(sinceIso)) / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function someoneWaiting(item: NeedsYouItem): boolean {
  return item.chips.some((c) => c.text === "Someone is waiting");
}

function ms(iso?: string): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Has this customer's last message been left without a reply for more than 2
 * business hours? "Replied" = we contacted them at or after their last message
 * (an owner-sent reply or an automatic one both stamp `lastContactedAt`).
 */
export function isCustomerWaiting(lead: Lead, now: Date, sla: TicketSlaSettings): boolean {
  if (!lead.lastInboundAt || lead.doNotContact || CLOSED_LEAD_STATUSES.has(lead.status)) return false;
  const inbound = ms(lead.lastInboundAt);
  if (!inbound) return false;
  if (lead.lastContactedAt && ms(lead.lastContactedAt) >= inbound) return false;
  const clockMode = sla.clockMode === "always_24_7" ? "always_24_7" : "business_hours";
  return computeSla({
    priority: "high",
    startedAt: new Date(inbound),
    now,
    settings: { ...sla, clockMode, highSlaMinutes: CUSTOMER_WAITING_BUSINESS_MINUTES },
  }).breached;
}

export async function getSlaSettings(workspaceId: string, repos: RepositoryBundle): Promise<TicketSlaSettings> {
  const saved = await repos.ticketSlaSettings.getByWorkspace(workspaceId).catch(() => undefined);
  return saved || ({ id: "default", createdAt: "", updatedAt: "", ...defaultTicketSlaSettings(workspaceId) } as TicketSlaSettings);
}

function money(amount: number, currencyCode?: string): string {
  return formatMoney(amount, currencyCode || "INR").replace(/\.00$/, "");
}

export async function buildNeedsYouList(
  workspaceId: string,
  repos: RepositoryBundle,
  options: { now?: Date; includeHeldReplies?: boolean } = {},
): Promise<NeedsYouList> {
  const now = options.now || new Date();
  const today = todayIstIsoDate(now);
  const includeHeld = options.includeHeldReplies !== false;
  const [leads, questions, quotes, logs, tickets, orders, due, proposed, sla, checklist] = await Promise.all([
    repos.lead.listLeads(workspaceId),
    repos.unknownQuestion.listByWorkspace(workspaceId, { status: "open" }),
    repos.quote.listByWorkspace(workspaceId),
    includeHeld ? repos.autoReplyLog.listByWorkspace(workspaceId) : Promise.resolve([] as AutoReplyLog[]),
    repos.ticket.listByWorkspace(workspaceId),
    repos.order.listByWorkspace(workspaceId),
    listDueReminders(workspaceId, today, repos),
    listProposedReminders(workspaceId, repos),
    getSlaSettings(workspaceId, repos),
    getWorkspaceChecklist(workspaceId, repos),
  ]);
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const out: NeedsYouItem[] = [];
  // Festival plan part 3 ("Promises"): a draft that names a day the company is
  // closed gets a red chip, so the owner sees the clash before approving it.
  const closedChips = (text: string | undefined) =>
    closedDayMentions(text || "", sla.closedDates || [], today).map((m) => ({
      text: `Names ${formatDate(m.date, now)}, when you are closed${m.label ? ` (${m.label})` : ""}`,
      tone: "danger" as const,
    }));

  // Held replies first, so a customer whose reply is already held is not ALSO
  // listed as "waiting" — one item per thing the owner must do.
  const heldLeadIds = new Set<string>();
  for (const log of logs) {
    if (!HELD_STATUSES.has(log.status)) continue;
    const lead = log.leadId ? leadById.get(log.leadId) : undefined;
    if (lead && log.leadId) heldLeadIds.add(log.leadId);
    out.push({
      id: `f:${log.id}`,
      bucket: "flag",
      title: lead ? `Held a reply to ${leadDisplayName(lead)}` : "Held a reply",
      summary: log.reason || "This draft needs your eyes before it sends.",
      at: log.updatedAt || log.createdAt,
      chips: [
        { text: "Nothing was sent", tone: "warning" },
        ...closedChips(log.generatedReply),
        ...(log.classification ? [{ text: displayReplyClassification(log.classification), tone: "neutral" as const }] : []),
      ],
      leadId: log.leadId,
      log,
      lead,
    });
  }

  // 2026-09-29 (owner walk-through R2): an APPROVED reply that never reached
  // the customer (WhatsApp not connected, window closed, a block). Approving
  // stamps the customer as contacted, so they left "waiting" although they
  // received nothing. One item per customer, their latest such reply, from the
  // last 30 days; "I sent it myself" in the inbox closes it.
  const undeliveredSince = now.getTime() - UNDELIVERED_LOOKBACK_DAYS * 86_400_000;
  const undeliveredByLead = new Map<string, AutoReplyLog>();
  for (const log of logs) {
    if (log.status !== "approved" || !log.leadId || heldLeadIds.has(log.leadId)) continue;
    if (replyDeliveryState(log).delivered) continue;
    if (ms(log.updatedAt || log.createdAt) < undeliveredSince) continue;
    const lead = leadById.get(log.leadId);
    if (!lead || lead.doNotContact || lead.status === "do_not_contact") continue;
    const seen = undeliveredByLead.get(log.leadId);
    if (!seen || ms(log.updatedAt || log.createdAt) > ms(seen.updatedAt || seen.createdAt)) undeliveredByLead.set(log.leadId, log);
  }
  for (const log of undeliveredByLead.values()) {
    const lead = leadById.get(log.leadId as string) as Lead;
    heldLeadIds.add(lead.id);
    out.push({
      id: `u:${log.id}`,
      bucket: "flag",
      title: `Your reply to ${leadDisplayName(lead)} did not reach them`,
      summary: replyDeliveryState(log).explanation,
      at: log.updatedAt || log.createdAt,
      chips: [{ text: "The customer got nothing", tone: "danger" }],
      leadId: lead.id,
      log,
      lead,
    });
  }

  for (const lead of leads) {
    if (heldLeadIds.has(lead.id) || !isCustomerWaiting(lead, now, sla)) continue;
    const last = (await repos.reply.listByLead(workspaceId, lead.id).catch(() => []))
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
    out.push({
      id: `w:${lead.id}`,
      bucket: "customer_waiting",
      title: `${leadDisplayName(lead)} is waiting for a reply`,
      summary: last?.rawText ? `“${last.rawText.slice(0, 160)}”` : "Their last message has had no reply.",
      at: lead.lastInboundAt as string,
      chips: [{ text: `No reply for ${waitedFor(lead.lastInboundAt as string, now)}`, tone: "danger" }],
      leadId: lead.id,
      lead,
    });
  }

  for (const ticket of tickets) {
    if (ticket.status === "waiting_customer") continue; // the customer's turn, not the owner's
    const live = computeLiveBreach(ticket, now);
    if (!Number.isFinite(live.remainingMinutes)) continue; // resolved / closed
    const dueToday = todayIstIsoDate(new Date(ticket.slaDueAt)) <= today;
    if (!live.breached && !dueToday) continue;
    const lead = ticket.leadId ? leadById.get(ticket.leadId) : undefined;
    out.push({
      id: `t:${ticket.id}`,
      bucket: "ticket",
      title: `Ticket #${ticket.ticketNumber}${lead ? ` · ${leadDisplayName(lead)}` : ""}`,
      summary: ticket.subject,
      at: ticket.slaDueAt,
      chips: [
        live.breached ? { text: "Late", tone: "danger" } : { text: "Due today", tone: "warning" },
        ...(ticket.priority === "urgent" ? [{ text: "Urgent", tone: "danger" as const }] : []),
      ],
      leadId: ticket.leadId,
      ticket,
      lead,
    });
  }

  // 2026-09-29 (walk-through NY4): one card per disagreement. The same
  // knowledge question raised by several documents shows once (the newest);
  // answering it closes the copies (AISettingsService.answerUnknownQuestion).
  const liveQuestions = questions.filter((q) => q.status === "open" && isLiveQuestion(q));
  const newestByKey = new Map<string, UnknownQuestion>();
  const copyCount = new Map<string, number>();
  for (const q of liveQuestions) {
    const key = sameQuestionKey(q);
    if (!key) continue;
    copyCount.set(key, (copyCount.get(key) || 0) + 1);
    const seen = newestByKey.get(key);
    if (!seen || ms(q.updatedAt || q.createdAt) > ms(seen.updatedAt || seen.createdAt)) newestByKey.set(key, q);
  }
  for (const q of liveQuestions) {
    const key = sameQuestionKey(q);
    if (key && newestByKey.get(key)?.id !== q.id) continue;
    const copies = key ? copyCount.get(key) || 1 : 1;
    const plain = plainQuestionTitle(q.questionText);
    out.push({
      id: `q:${q.id}`,
      bucket: "question",
      title: plain,
      summary: q.generatedBy === "learned_from_outcomes" ? "Learned from your customers' results" : q.missingTopic ? knowledgeAreaName(q.missingTopic) : "No confident answer yet",
      at: q.updatedAt || q.createdAt,
      chips: [
        ...(q.channel === "whatsapp" || q.leadId || q.conversationId ? [{ text: "Someone is waiting", tone: "danger" as const }] : []),
        ...(q.generatedBy === "conflict_detection"
          ? [isNewDetailQuestion(q.questionText) ? { text: "New detail to check", tone: "neutral" as const } : { text: "Two saved answers disagree", tone: "warning" as const }]
          : []),
        ...(q.channel === "whatsapp" ? [{ text: "WhatsApp", tone: "neutral" as const }] : []),
        ...(copies > 1 ? [{ text: `Raised ${copies} times`, tone: "neutral" as const }] : []),
      ],
      leadId: q.leadId,
      question: { ...q, questionText: plain, isEssential: isEssentialSetupQuestion(q) } as UnknownQuestion,
    });
  }

  for (const quote of quotes) {
    const lead = leadById.get(quote.leadId);
    const inr = (quote.currencyCode || "INR").toUpperCase() === "INR";
    if (quote.status === "draft") {
      const unpriced = quote.lineItems.filter((line) => !(line.unitPrice > 0)).length;
      out.push({
        id: `m:${quote.id}`,
        bucket: "money",
        title: `Quote #${quote.quoteNumber}${lead ? ` · ${leadDisplayName(lead)}` : ""}`,
        summary: unpriced
          ? "A draft quote. A rate is missing, so it cannot go out."
          : "A draft quote, priced and waiting for your OK.",
        at: quote.updatedAt || quote.createdAt,
        chips: [
          ...(unpriced
            ? [{ text: `${unpriced} line${unpriced === 1 ? "" : "s"} with no price`, tone: "danger" as const }]
            : [{ text: money(quote.grandTotal, quote.currencyCode), tone: "neutral" as const }]),
          ...closedChips([quote.notes, quote.validityNote].filter(Boolean).join(" · ")),
        ],
        leadId: quote.leadId,
        amountInr: inr ? quote.grandTotal : undefined,
        quote,
        lead,
      });
      continue;
    }
    if (quote.status !== "sent") continue;
    const sentAt = ms(quote.sentAt || quote.updatedAt);
    if (!sentAt || now.getTime() - sentAt <= QUOTE_NO_ANSWER_DAYS * DAY_MS) continue;
    if (lead?.lastInboundAt && ms(lead.lastInboundAt) > sentAt) continue; // they wrote back
    const days = Math.floor((now.getTime() - sentAt) / DAY_MS);
    out.push({
      id: `s:${quote.id}`,
      bucket: "quote_waiting",
      title: `Quote #${quote.quoteNumber}${lead ? ` · ${leadDisplayName(lead)}` : ""}`,
      summary: `Sent ${days} days ago. No answer from the customer since.`,
      at: quote.sentAt || quote.updatedAt,
      chips: [{ text: money(quote.grandTotal, quote.currencyCode), tone: "neutral" }, { text: `${days} days, no answer`, tone: "warning" }],
      leadId: quote.leadId,
      amountInr: inr ? quote.grandTotal : undefined,
      quote,
      lead,
    });
  }

  for (const order of orders) {
    if (!ORDER_WAITING_STATUSES.has(order.status)) continue;
    const since = ms(order.status === "partial_shipped" ? order.shippedAt || order.updatedAt : order.confirmedAt || order.updatedAt || order.createdAt);
    if (!since || now.getTime() - since <= ORDER_WAITING_DAYS * DAY_MS) continue;
    const lead = leadById.get(order.leadId);
    const days = Math.floor((now.getTime() - since) / DAY_MS);
    const partly = order.status === "partial_shipped";
    out.push({
      id: `o:${order.id}`,
      bucket: "order",
      title: `Order #${order.orderNumber}${lead ? ` · ${leadDisplayName(lead)}` : ""}`,
      summary: partly ? `Partly shipped ${days} days ago. The rest has not gone out.` : `Confirmed ${days} days ago and not shipped yet.`,
      at: new Date(since).toISOString(),
      chips: [{ text: money(order.grandTotal, order.currencyCode), tone: "neutral" }, { text: partly ? "Partly shipped" : "To ship", tone: "warning" }],
      leadId: order.leadId,
      amountInr: (order.currencyCode || "INR").toUpperCase() === "INR" ? order.grandTotal : undefined,
      order,
      lead,
    });
  }

  for (const reminder of [...due, ...proposed]) {
    const lead = leadById.get(reminder.leadId);
    const suggested = reminder.status === "proposed";
    out.push({
      id: `r:${reminder.id}`,
      bucket: "reminder",
      title: `${suggested ? "Suggested reminder" : "Reminder"}${lead ? ` · ${leadDisplayName(lead)}` : ""}`,
      summary: reminder.note,
      at: reminder.updatedAt || reminder.createdAt,
      chips: suggested
        ? [{ text: reminder.source === "ai_proposed" ? (reminder.kind === "dormant" ? "Gone quiet" : "Usual reorder time") : "From the customer's message", tone: "neutral" }]
        : [{ text: "Due today", tone: "warning" }],
      leadId: reminder.leadId,
      reminder,
      lead,
    });
  }

  for (const lead of leads) {
    if (lead.reviewStatus !== "pending") continue;
    out.push({
      id: `l:${lead.id}`,
      bucket: "lead",
      title: `${leadDisplayName(lead)} · ${isAiScored(lead) ? `score ${leadScoreText(lead)}` : "not scored yet"}`,
      summary: lead.fitReason || lead.relevancyReason || "Discovered prospect waiting for your approve / reject.",
      at: lead.updatedAt || lead.createdAt,
      chips: lead.doNotContact ? [{ text: "Do not contact", tone: "danger" }] : [],
      leadId: lead.id,
      lead,
    });
  }

  // Bucket order, then: the longest-waiting customer and the earliest deadline
  // first; everything else newest first.
  const oldestFirst = new Set<NeedsYouBucket>(["customer_waiting", "ticket", "order", "quote_waiting"]);
  out.sort((a, b) => {
    const d = NEEDS_YOU_BUCKETS.indexOf(a.bucket) - NEEDS_YOU_BUCKETS.indexOf(b.bucket);
    if (d !== 0) return d;
    // 2026-09-29 (walk-through NY5): inside "the AI is asking you", a question a
    // customer is waiting on comes before the knowledge housekeeping.
    if (a.bucket === "question") {
      const w = Number(someoneWaiting(b)) - Number(someoneWaiting(a));
      if (w !== 0) return w;
    }
    return oldestFirst.has(a.bucket) ? String(a.at).localeCompare(String(b.at)) : String(b.at).localeCompare(String(a.at));
  });

  // 2026-09-30 — a buying-season festival 7–28 days away, with the customers
  // who ordered before it last year. Never blocks the list if the calendar or
  // the history cannot be read.
  for (const prompt of await festivalPrompts(workspaceId, repos, now).catch(() => [] as FestivalPrompt[])) {
    out.push({
      id: `fest:${prompt.key}:${prompt.date}`,
      bucket: "festival",
      title: /\(first day\)$/.test(prompt.name)
        ? `${prompt.name.replace(/ \(first day\)$/, "")} starts in ${prompt.daysAway} days`
        : `${prompt.name} is in ${prompt.daysAway} days`,
      summary: prompt.basis === "last_year_festival"
        ? `${prompt.customers.length} customer${prompt.customers.length === 1 ? "" : "s"} ordered in the weeks before ${prompt.name} last year.`
        : `${prompt.customers.length} customer${prompt.customers.length === 1 ? "" : "s"} ordered from you in the last 12 months.`,
      at: `${prompt.date}T00:00:00+05:30`,
      chips: [{ text: "Buying season", tone: "neutral" }],
      festival: prompt,
    });
  }

  const counts = Object.fromEntries(NEEDS_YOU_BUCKETS.map((b) => [b, 0])) as Record<NeedsYouBucket, number>;
  for (const item of out) counts[item.bucket]++;
  // 2026-09-30 (page guide): the setup backlog is counted exactly as the
  // Questions from AI screen counts it: open business questions this company is
  // still asked. It used to count every open non-live question, including ones
  // kept on file for questions the business is no longer asked, so Needs you
  // said "31 essential, 479 can wait" while Questions said 37 and 227.
  const backlog = questions.filter((q) =>
    q.status === "open"
    && q.channel === "knowledge"
    && (!q.relatedDomain || !q.relatedQuestionKey || checklist.keys.has(`${q.relatedDomain}/${q.relatedQuestionKey}`)));
  return {
    items: out,
    count: out.length,
    counts,
    setupBacklog: backlog.length,
    essentialBacklog: backlog.filter((q) => isEssentialSetupQuestion(q)).length,
    generatedAt: now.toISOString(),
  };
}
