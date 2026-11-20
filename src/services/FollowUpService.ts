/**
 * Reminders for later — the system's memory of things to DO about a customer
 * ("call after Diwali", "send the new shade card next month"). 2026-09-27, CEO.
 * Plan: docs/planning/DAILY-ROUTINE-AND-REMINDERS-PLAN.md §2.
 *
 * Rules:
 *   - The owner creates a reminder (open) from the customer panel.
 *   - When a customer names a time in a message, the AI only PROPOSES one, with
 *     the customer's words as evidence. A proposal counts for nothing until the
 *     owner confirms it with a date (no hallucination: a date the system
 *     guessed is never acted on by itself).
 *   - Only open reminders count. The earliest one is written to
 *     Lead.nextFollowUpAt, which the dashboard's "follow-ups due" reads.
 *   - Due reminders appear in the morning summary and "Needs you". Nothing is
 *     ever sent to the customer by a reminder.
 *   - A customer on do-not-contact is never due, and cannot be given a new one.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { FollowUp, Lead } from "@/lib/types";
import { createRepositories } from "@/repositories";
import { NeedsActionError } from "@/lib/user-errors";
import { todayIstIsoDate } from "@/lib/time";
import { isContactBlocked } from "@/lib/dnc-registry";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NOTE = 300;

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

async function isDoNotContact(workspaceId: string, lead: Lead, repos: RepositoryBundle): Promise<boolean> {
  return (await isContactBlocked(workspaceId, lead, repos)).blocked;
}

async function requireLead(workspaceId: string, leadId: string, repos: RepositoryBundle): Promise<Lead> {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  if (!lead) throw new NeedsActionError("That customer no longer exists.", 404);
  return lead;
}

async function requireReminder(workspaceId: string, id: string, repos: RepositoryBundle): Promise<FollowUp> {
  const item = await repos.followUp.getById(workspaceId, id);
  if (!item) throw new NeedsActionError("That reminder no longer exists.", 404);
  return item;
}

/** Keep Lead.nextFollowUpAt equal to the earliest open reminder (09:00 IST that day), or empty. */
export async function syncNextFollowUp(workspaceId: string, leadId: string, repos: RepositoryBundle): Promise<void> {
  const lead = await requireLead(workspaceId, leadId, repos);
  const blocked = await isDoNotContact(workspaceId, lead, repos);
  const open = (await repos.followUp.listByWorkspace(workspaceId, { leadId, status: "open" }))
    .filter((f) => !blocked && f.dueOn && isRealDate(f.dueOn))
    .sort((a, b) => String(a.dueOn).localeCompare(String(b.dueOn)));
  const next = open[0]?.dueOn ? `${open[0].dueOn}T09:00:00+05:30` : null;
  await repos.lead.updateLead(workspaceId, leadId, { nextFollowUpAt: (next ? new Date(next).toISOString() : null) as unknown as string });
}

export async function createReminder(
  workspaceId: string,
  input: { leadId: string; dueOn: string; note: string; createdBy?: string },
  repos: RepositoryBundle = createRepositories(),
): Promise<FollowUp> {
  const lead = await requireLead(workspaceId, input.leadId, repos);
  if (await isDoNotContact(workspaceId, lead, repos)) throw new NeedsActionError("This customer asked not to be contacted, so no reminder can be set.", 409);
  const note = String(input.note || "").trim();
  if (!note) throw new NeedsActionError("Write what the reminder is for.", 400);
  if (note.length > MAX_NOTE) throw new NeedsActionError(`Keep the reminder under ${MAX_NOTE} characters.`, 400);
  const dueOn = String(input.dueOn || "").trim();
  if (!isRealDate(dueOn)) throw new NeedsActionError("Pick a date for the reminder.", 400);
  const created = await repos.followUp.create(workspaceId, { leadId: lead.id, dueOn, note, source: "owner", status: "open", createdBy: input.createdBy });
  await syncNextFollowUp(workspaceId, lead.id, repos);
  return created;
}

/** The owner accepts an AI proposal, giving (or correcting) its date. */
export async function confirmReminder(workspaceId: string, id: string, input: { dueOn?: string; note?: string }, repos: RepositoryBundle = createRepositories()): Promise<FollowUp> {
  const item = await requireReminder(workspaceId, id, repos);
  if (item.status !== "proposed") throw new NeedsActionError("This reminder is already confirmed or closed.", 409);
  const lead = await requireLead(workspaceId, item.leadId, repos);
  if (await isDoNotContact(workspaceId, lead, repos)) throw new NeedsActionError("This customer asked not to be contacted, so no reminder can be set.", 409);
  const dueOn = String(input.dueOn || item.dueOn || "").trim();
  if (!isRealDate(dueOn)) throw new NeedsActionError("Pick a date for the reminder.", 400);
  const note = input.note !== undefined ? String(input.note).trim() : item.note;
  if (!note) throw new NeedsActionError("Write what the reminder is for.", 400);
  const updated = await repos.followUp.update(workspaceId, id, { status: "open", dueOn, note: note.slice(0, MAX_NOTE) });
  await syncNextFollowUp(workspaceId, item.leadId, repos);
  return updated;
}

export async function closeReminder(workspaceId: string, id: string, outcome: "done" | "dismissed", repos: RepositoryBundle = createRepositories()): Promise<FollowUp> {
  const item = await requireReminder(workspaceId, id, repos);
  if (item.status === "done" || item.status === "dismissed") return item;
  const updated = await repos.followUp.update(workspaceId, id, { status: outcome, doneAt: new Date().toISOString() });
  await syncNextFollowUp(workspaceId, item.leadId, repos);
  return updated;
}

export async function listRemindersForLead(workspaceId: string, leadId: string, repos: RepositoryBundle = createRepositories()): Promise<FollowUp[]> {
  await requireLead(workspaceId, leadId, repos);
  return (await repos.followUp.listByWorkspace(workspaceId, { leadId }))
    .filter((f) => f.status === "open" || f.status === "proposed")
    .sort((a, b) => String(a.dueOn || "9999").localeCompare(String(b.dueOn || "9999")));
}

/** Open reminders due on or before `day` (IST), for customers who may still be contacted. */
export async function listDueReminders(workspaceId: string, day: string = todayIstIsoDate(), repos: RepositoryBundle = createRepositories()): Promise<Array<FollowUp & { companyName?: string }>> {
  const open = (await repos.followUp.listByWorkspace(workspaceId, { status: "open" })).filter((f) => f.dueOn && isRealDate(f.dueOn) && f.dueOn <= day);
  const out: Array<FollowUp & { companyName?: string }> = [];
  for (const f of open) {
    const lead = await repos.lead.getLeadById(workspaceId, f.leadId);
    if (!lead || await isDoNotContact(workspaceId, lead, repos)) continue;
    out.push({ ...f, companyName: lead.companyName || lead.contactName || undefined });
  }
  return out.sort((a, b) => String(a.dueOn).localeCompare(String(b.dueOn)));
}

export async function listProposedReminders(workspaceId: string, repos: RepositoryBundle = createRepositories()): Promise<FollowUp[]> {
  const proposals = await repos.followUp.listByWorkspace(workspaceId, { status: "proposed" });
  const eligible: FollowUp[] = [];
  for (const proposal of proposals) {
    const lead = await repos.lead.getLeadById(workspaceId, proposal.leadId);
    if (lead && !(await isDoNotContact(workspaceId, lead, repos))) eligible.push(proposal);
  }
  return eligible;
}

export async function countFollowUpsDue(workspaceId: string, day: string = todayIstIsoDate(), repos: RepositoryBundle = createRepositories()): Promise<number> {
  return (await listDueReminders(workspaceId, day, repos)).length;
}

// ---------------------------------------------------------------------------
// Proposals from what a customer wrote. Deterministic and cheap: no AI call.
// A phrase with a date we can work out ("next week", "after 15th") carries a
// suggested date; one we cannot ("after Diwali") carries none, and the owner
// picks it. Either way nothing counts until the owner confirms.
// ---------------------------------------------------------------------------

type TimePhrase = { pattern: RegExp; suggest?: (today: Date) => Date };

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

const TIME_PHRASES: TimePhrase[] = [
  { pattern: /\b(?:day after tomorrow|parso)\b/i, suggest: (t) => addDays(t, 2) },
  { pattern: /\b(?:tomorrow|kal)\b/i, suggest: (t) => addDays(t, 1) },
  { pattern: /\b(?:next week|agle hafte|agle week)\b/i, suggest: (t) => addDays(t, 7) },
  { pattern: /\b(?:in|after)\s+(\d{1,2})\s+days?\b/i },
  { pattern: /\b(?:next month|agle mahine|agle month)\b/i, suggest: (t) => addDays(t, 30) },
  { pattern: /\bafter\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i },
  { pattern: /\b(?:after|baad)\s+(?:diwali|holi|navratri|dussehra|eid|rakhi|pongal|new year)\b|\b(?:diwali|holi|navratri|dussehra)\s+(?:ke\s+)?baad\b/i },
  { pattern: /\b(?:call|contact|message|ping)\s+(?:me\s+)?(?:later|after)\b/i },
  { pattern: /(?:આવતા અઠવાડિયે|આવતા મહિને|દિવાળી પછી|अगले हफ्ते|अगले महीने|दिवाली के बाद)/ },
];

function istToday(): Date {
  return new Date(`${todayIstIsoDate()}T00:00:00Z`);
}

export function findTimePhrase(text: string, today: Date = istToday()): { phrase: string; suggestedDueOn?: string } | undefined {
  for (const { pattern, suggest } of TIME_PHRASES) {
    const match = text.match(pattern);
    if (!match) continue;
    let when: Date | undefined = suggest?.(today);
    if (!when && /days?/i.test(match[0]) && match[1]) when = addDays(today, Number(match[1]));
    if (!when && /after\s+(?:the\s+)?\d/i.test(match[0]) && match[1]) {
      const dayOfMonth = Number(match[1]);
      if (dayOfMonth >= 1 && dayOfMonth <= 31) {
        const candidate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), dayOfMonth + 1));
        when = candidate > today ? candidate : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, dayOfMonth + 1));
      }
    }
    return { phrase: match[0], suggestedDueOn: when ? when.toISOString().slice(0, 10) : undefined };
  }
  return undefined;
}

/**
 * After an incoming message: if the customer named a time, propose a reminder
 * with their words. Never throws; never proposes twice for the same words.
 */
export async function proposeReminderFromMessage(workspaceId: string, leadId: string, text: string, repos: RepositoryBundle = createRepositories()): Promise<FollowUp | undefined> {
  try {
    const found = findTimePhrase(text || "");
    if (!found) return undefined;
    const lead = await repos.lead.getLeadById(workspaceId, leadId);
    if (!lead || await isDoNotContact(workspaceId, lead, repos)) return undefined;
    const evidence = text.trim().slice(0, 500);
    const existing = await repos.followUp.listByWorkspace(workspaceId, { leadId });
    if (existing.some((f) => f.evidence === evidence)) return undefined;
    return await repos.followUp.create(workspaceId, {
      leadId,
      dueOn: found.suggestedDueOn,
      note: `Customer said: "${found.phrase}" — follow up then.`,
      source: "customer_said",
      evidence,
      status: "proposed",
    });
  } catch (error) {
    console.warn("[followups] proposing a reminder failed:", error instanceof Error ? error.message : error);
    return undefined;
  }
}
