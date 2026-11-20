/**
 * OutcomeLearningService — the weekly "what worked" check (2026-09-28, CEO
 * overnight; review 2026-09-27 §1 design D).
 *
 * Once per 7 days per company, inside the daily routine:
 *   1. take the outcome signals of the last LEARNING_WINDOW_DAYS days;
 *   2. join each to what reached that customer in the 14 days before it —
 *      the KIND of reply (greeting, catalogue request…), the CAMPAIGN, and the
 *      WORDING GROUP of the first message they got;
 *   3. for every value of every dimension, compare how often the result was
 *      good (order placed, quote accepted, won) with everyone else;
 *   4. only when a pattern clears a CLEAR threshold — at least MIN_OUTCOMES
 *      results on each side and a difference of at least MIN_DIFFERENCE —
 *      PROPOSE it to the owner as a card in "Needs you", with the evidence.
 *
 * It never changes a prompt, a setting, a ticked kind or the knowledge base.
 * The card is the same kind LearnedRuleService makes (an UnknownQuestion,
 * generatedBy "learned_from_outcomes"): the owner writes guidance in their own
 * words if they agree, or says "change nothing". A sensitive kind (price,
 * delivery, complaint…) is only ever described — it stays with the owner.
 * Counting is free: no AI call.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AutoReplyLog, AutoReplyPause, FollowUp, Lead, OutcomeSignal, OutreachActivity, UnknownQuestion } from "@/lib/types";
import { logCategory, isAutoReplyTopic } from "@/services/AutoReplyTrialService";
import { OUTCOME_LOOKBACK_DAYS, POSITIVE_OUTCOMES, replyReachedCustomer } from "@/services/OutcomeSignalService";
import { displayReplyClassification } from "@/lib/display-labels";

export const LEARNING_EVERY_DAYS = 7;
export const LEARNING_WINDOW_DAYS = 90;
/** Results needed on EACH side of a comparison before anything is proposed. */
export const MIN_OUTCOMES = 5;
/** Share of good results must differ by at least this much (0.3 = 30 points). */
export const MIN_DIFFERENCE = 0.3;
/** The same pattern is not proposed again within this many days of the last card. */
export const REPROPOSE_AFTER_DAYS = 90;
export const OUTCOME_LEARNING_JOB = "outcome_learning_week";
const DAY_MS = 86_400_000;

type Dimension = "reply_kind" | "campaign" | "first_message";
type Features = Record<Dimension, Set<string>>;

export type OutcomePattern = {
  dimension: Dimension;
  value: string;
  label: string;
  withGood: number;
  withTotal: number;
  restGood: number;
  restTotal: number;
  better: boolean;
  signalIds: string[];
};

/** Group a first message by its opening words, with the customer's own names taken out. */
export function wordingGroup(body: string, lead?: Pick<Lead, "contactName" | "companyName">): string {
  let text = ` ${String(body || "").toLowerCase()} `;
  for (const name of [lead?.contactName, lead?.companyName]) {
    for (const word of String(name || "").toLowerCase().split(/\s+/).filter((w) => w.length > 1)) {
      text = text.split(` ${word} `).join(" ").split(` ${word}, `).join(" ");
    }
  }
  return text.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
}

const SENSITIVE = new Set(["price_request", "payment_question", "delivery_question", "return_question", "complaint", "abusive_message", "customization_question", "export_question", "bulk_order_interest", "hot_lead"]);

/** Pure: what reached each customer in the lookback before each signal. */
export function featuresFor(
  signal: OutcomeSignal,
  logsForLead: AutoReplyLog[],
  outboundForLead: OutreachActivity[],
  lead: Lead | undefined,
): Features {
  const at = Date.parse(signal.at);
  const from = at - OUTCOME_LOOKBACK_DAYS * DAY_MS;
  const inWindow = (iso: string) => {
    const t = Date.parse(iso || "");
    return Number.isFinite(t) && t >= from && t <= at;
  };
  const features: Features = { reply_kind: new Set(), campaign: new Set(), first_message: new Set() };
  for (const log of logsForLead) {
    if (!replyReachedCustomer(log) || !inWindow(log.createdAt)) continue;
    const kind = logCategory(log);
    if (kind) features.reply_kind.add(kind);
  }
  const outbound = outboundForLead
    .filter((a) => a.direction === "outbound" && ["sent", "sent_manual", "sent_api", "approved", "manual"].includes(a.status))
    .sort((a, b) => (a.activityAt || a.createdAt).localeCompare(b.activityAt || b.createdAt));
  for (const a of outbound) if (a.campaignId && inWindow(a.activityAt || a.createdAt)) features.campaign.add(a.campaignId);
  const first = outbound[0];
  if (first && inWindow(first.activityAt || first.createdAt)) {
    const group = wordingGroup(first.body, lead);
    if (group) features.first_message.add(group);
  }
  return features;
}

/** Pure: the patterns that clear the threshold. */
export function findPatterns(rows: Array<{ signal: OutcomeSignal; features: Features }>, labels: (d: Dimension, v: string) => string): OutcomePattern[] {
  const good = (s: OutcomeSignal) => (POSITIVE_OUTCOMES as readonly string[]).includes(s.kind);
  const out: OutcomePattern[] = [];
  for (const dimension of ["reply_kind", "campaign", "first_message"] as Dimension[]) {
    // Only results where something of this dimension was sent are compared —
    // "no campaign at all" is not the same as "a different campaign".
    const scoped = rows.filter((r) => r.features[dimension].size > 0);
    const values = new Set(scoped.flatMap((r) => [...r.features[dimension]]));
    for (const value of values) {
      const withV = scoped.filter((r) => r.features[dimension].has(value));
      const rest = scoped.filter((r) => !r.features[dimension].has(value));
      if (withV.length < MIN_OUTCOMES || rest.length < MIN_OUTCOMES) continue;
      const withGood = withV.filter((r) => good(r.signal)).length;
      const restGood = rest.filter((r) => good(r.signal)).length;
      const diff = withGood / withV.length - restGood / rest.length;
      if (Math.abs(diff) < MIN_DIFFERENCE) continue;
      out.push({
        dimension, value, label: labels(dimension, value),
        withGood, withTotal: withV.length, restGood, restTotal: rest.length,
        better: diff > 0,
        signalIds: withV.map((r) => r.signal.id),
      });
    }
  }
  return out;
}

const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;

export function describePattern(p: OutcomePattern): { question: string; evidence: string } {
  const subject = p.dimension === "reply_kind"
    ? `customers who got your replies to a ${p.label}`
    : p.dimension === "campaign"
      ? `customers reached through the campaign "${p.label}"`
      : `customers whose first message began "${p.label}…"`;
  const question = p.better
    ? `Results are better for ${subject}. Do more of this?`
    : `Results are worse for ${subject}. Change how this is done?`;
  const sensitive = p.dimension === "reply_kind" && SENSITIVE.has(p.value)
    ? " This topic always waits for you before anything is sent; that does not change."
    : "";
  const evidence = `In the last ${LEARNING_WINDOW_DAYS} days, ${p.withGood} of ${p.withTotal} ${subject} ended well (an order, an accepted quote or a win) — ${pct(p.withGood, p.withTotal)} — against ${p.restGood} of ${p.restTotal} (${pct(p.restGood, p.restTotal)}) for everyone else. Nothing has been changed.${sensitive}`;
  return { question, evidence };
}

export type LearnedThisWeek = {
  /** Kinds the system switched off in the last 7 days, or not yet read by the owner. */
  switchedOff: AutoReplyPause[];
  /** Open proposals from results or from the owner's corrections, made in the last 7 days. */
  proposals: UnknownQuestion[];
  /** Reorder / dormant suggestions still waiting for the owner. */
  reorders: Array<FollowUp & { companyName?: string }>;
};

/** "What the system learned this week" — proposals only, each with its evidence. */
export async function getLearnedThisWeek(workspaceId: string, repos: RepositoryBundle, now: Date = new Date()): Promise<LearnedThisWeek> {
  const weekAgo = now.getTime() - 7 * DAY_MS;
  const recent = (iso?: string) => Date.parse(iso || "") >= weekAgo;
  const settings = await repos.whatsAppAgentSettings.getByWorkspace(workspaceId);
  const switchedOff = (settings?.autoReplyPaused ?? []).filter((p) => !p.seenAt || recent(p.pausedAt));
  const proposals = (await repos.unknownQuestion.listByWorkspace(workspaceId, { status: "open" }))
    .filter((q) => (q.generatedBy === "learned_from_outcomes" || q.generatedBy === "learned_from_corrections") && recent(q.createdAt));
  const reorders: Array<FollowUp & { companyName?: string }> = [];
  for (const f of await repos.followUp.listByWorkspace(workspaceId, { status: "proposed" })) {
    if (f.source !== "ai_proposed" || !f.kind) continue;
    const lead = await repos.lead.getLeadById(workspaceId, f.leadId);
    if (!lead) continue;
    reorders.push({ ...f, companyName: lead.companyName || lead.contactName || undefined });
  }
  return { switchedOff, proposals, reorders };
}

export type LearningRunResult ={ ran: boolean; reason?: string; proposed: UnknownQuestion[]; patterns: number };

export async function runWeeklyOutcomeLearning(workspaceId: string, repos: RepositoryBundle, now: Date = new Date()): Promise<LearningRunResult> {
  const jobs = (await repos.jobRun.listByWorkspace(workspaceId)).filter((j) => j.jobType === OUTCOME_LEARNING_JOB);
  const lastRun = Math.max(0, ...jobs.map((j) => Date.parse(j.createdAt || "")).filter(Number.isFinite));
  if (lastRun && now.getTime() - lastRun < LEARNING_EVERY_DAYS * DAY_MS) {
    return { ran: false, reason: "already looked this week", proposed: [], patterns: 0 };
  }
  // Claimed before the work: a restart mid-way does not run it twice this week.
  const job = await repos.jobRun.create({ workspaceId, jobType: OUTCOME_LEARNING_JOB, status: "running", payload: { at: now.toISOString() } as never, attempts: 1, maxAttempts: 1 });

  try {
  const since = new Date(now.getTime() - LEARNING_WINDOW_DAYS * DAY_MS).toISOString();
  const signals = (await repos.outcomeSignal.listByWorkspace(workspaceId, { since })).filter((s) => s.at <= now.toISOString());
  const leadIds = [...new Set(signals.map((s) => s.leadId))];
  const leads = new Map<string, Lead>();
  const logs = new Map<string, AutoReplyLog[]>();
  const outbound = new Map<string, OutreachActivity[]>();
  for (const id of leadIds) {
    const lead = await repos.lead.getLeadById(workspaceId, id);
    if (lead) leads.set(id, lead);
    logs.set(id, await repos.autoReplyLog.listByLead(workspaceId, id));
    outbound.set(id, await repos.outreachActivity.listByLead(workspaceId, id));
  }
  const rows = signals.map((signal) => ({ signal, features: featuresFor(signal, logs.get(signal.leadId) ?? [], outbound.get(signal.leadId) ?? [], leads.get(signal.leadId)) }));
  const campaigns = new Map((await repos.campaign.listByWorkspace(workspaceId)).map((c) => [c.id, c.name]));
  const patterns = findPatterns(rows, (d, v) => d === "reply_kind"
    ? displayReplyClassification(v).toLowerCase()
    : d === "campaign" ? campaigns.get(v) || "an unnamed campaign" : v);

  const existing = (await repos.unknownQuestion.listByWorkspace(workspaceId)).filter((q) => q.generatedBy === "learned_from_outcomes");
  const proposed: UnknownQuestion[] = [];
  for (const p of patterns) {
    const key = `outcome:${p.dimension}:${p.value}:${p.better ? "better" : "worse"}`;
    const recent = existing.some((q) => q.missingTopic === key
      && (q.status === "open" || now.getTime() - Date.parse(q.createdAt || "") < REPROPOSE_AFTER_DAYS * DAY_MS));
    if (recent) continue;
    const { question, evidence } = describePattern(p);
    proposed.push(await repos.unknownQuestion.create(workspaceId, {
      channel: "outcomes",
      questionText: question,
      suggestedAnswer: evidence,
      generatedBy: "learned_from_outcomes",
      missingTopic: key,
      relatedDomain: p.dimension === "reply_kind" && isAutoReplyTopic(p.value) ? "auto_reply" : p.dimension,
      status: "open",
      priority: "low",
      sourceIds: p.signalIds,
    }));
  }
  await repos.jobRun.update(workspaceId, job.id, { status: "completed", completedAt: new Date().toISOString(), result: { proposals: proposed.length, patterns: patterns.length } });
  return { ran: true, proposed, patterns: patterns.length };
  } catch (error) {
    // Preserve the once-per-week claim rule, but never label a failed read or
    // proposal write as completed. The daily routine retains the thrown error.
    await repos.jobRun.update(workspaceId, job.id, { status: "failed", errorMessage: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
    throw error;
  }
}
