/**
 * "Diwali is coming — remind them?" (2026-09-30, CEO-approved plan
 * docs/planning/FESTIVAL-CALENDAR-PLAN.md part 3; rules docs/LOGIC.md
 * FESTIVAL-CALENDAR).
 *
 * For a buying-season festival (Diwali, Navratri, Holi, Eid, Raksha Bandhan,
 * Ganesh Chaturthi, Christmas) 7 to 28 days away, Needs you shows one card:
 * the customers who ordered in the 60 days before the same festival last year
 * (or, with no such history, anyone who ordered in the last 12 months). The
 * owner can set a reminder for each of them, or say "not this year". Nothing
 * is ever sent to a customer from here, and a do-not-contact customer is never
 * listed.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Lead } from "@/lib/types";
import { createRepositories } from "@/repositories";
import { NeedsActionError } from "@/lib/user-errors";
import { todayIstIsoDate } from "@/lib/time";
import { formatDate } from "@/lib/format-date";
import { FESTIVAL_BY_KEY, FESTIVALS, festivalDate, type FestivalKey } from "@/lib/festival-calendar";
import { getFestivalCalendar } from "@/services/FestivalCalendarService";
import { createReminder } from "@/services/FollowUpService";
import { AuditLogService } from "@/services/AuditLogService";

export const PROMPT_MIN_DAYS = 7;
export const PROMPT_MAX_DAYS = 28;
export const HISTORY_WINDOW_DAYS = 60;
/** Reminders are set this many days before the festival (or today, if that is later). */
export const REMIND_DAYS_BEFORE = 14;
const HANDLED_EVENT = "festival.prompt_handled";
const MAX_LISTED = 25;

export type FestivalPrompt = {
  key: FestivalKey;
  name: string;
  date: string;
  daysAway: number;
  /** Whether the list comes from last year's orders around this festival. */
  basis: "last_year_festival" | "last_12_months";
  customers: Array<{ leadId: string; name: string }>;
};

const DAY_MS = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const minusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);

function contactable(lead: Lead | undefined): lead is Lead {
  return Boolean(lead) && !lead!.doNotContact && lead!.status !== "do_not_contact";
}

async function handledKeys(workspaceId: string, repos: RepositoryBundle): Promise<Set<string>> {
  const logs = await repos.auditLog.listByWorkspace(workspaceId).catch(() => []);
  const out = new Set<string>();
  for (const log of logs) {
    if (log.eventType !== HANDLED_EVENT) continue;
    const p = (log.payload || {}) as Record<string, unknown>;
    const inner = (p.newValuesJson || p) as Record<string, unknown>;
    if (inner.festival && inner.date) out.add(`${inner.festival}:${inner.date}`);
  }
  return out;
}

/** The festival cards for Needs you (usually none; at most one per coming festival). */
export async function festivalPrompts(workspaceId: string, repos: RepositoryBundle = createRepositories(), now: Date = new Date()): Promise<FestivalPrompt[]> {
  const today = todayIstIsoDate(now);
  const calendar = await getFestivalCalendar(now.getTime());
  const handled = await handledKeys(workspaceId, repos);
  const coming = FESTIVALS.filter((f) => f.season)
    .map((f) => calendar.days.find((d) => d.key === f.key && d.date >= today))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .filter((d) => { const away = days(today, d.date); return away >= PROMPT_MIN_DAYS && away <= PROMPT_MAX_DAYS; })
    .filter((d) => !handled.has(`${d.key}:${d.date}`));
  if (!coming.length) return [];

  const [orders, leads] = await Promise.all([repos.order.listByWorkspace(workspaceId), repos.lead.listLeads(workspaceId)]);
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const placed = orders.filter((o) => o.status !== "cancelled" && o.leadId);
  const out: FestivalPrompt[] = [];
  for (const day of coming) {
    const lastYear = festivalDate(calendar.days, day.key, Number(day.date.slice(0, 4)) - 1);
    let basis: FestivalPrompt["basis"] = "last_year_festival";
    let ids = new Set<string>();
    if (lastYear) {
      const from = minusDays(lastYear.date, HISTORY_WINDOW_DAYS);
      for (const o of placed) {
        const at = String(o.createdAt).slice(0, 10);
        if (at >= from && at <= lastYear.date) ids.add(o.leadId as string);
      }
    }
    if (!ids.size) {
      basis = "last_12_months";
      const from = minusDays(today, 365);
      ids = new Set(placed.filter((o) => String(o.createdAt).slice(0, 10) >= from).map((o) => o.leadId as string));
    }
    const customers = [...ids]
      .map((id) => leadById.get(id))
      .filter(contactable)
      .map((l) => ({ leadId: l.id, name: l.companyName || l.contactName || "Unnamed customer" }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_LISTED);
    if (!customers.length) continue;
    out.push({ key: day.key, name: day.name, date: day.date, daysAway: days(today, day.date), basis, customers });
  }
  return out;
}

async function markHandled(workspaceId: string, prompt: { key: FestivalKey; date: string }, outcome: "reminded" | "not_this_year", repos: RepositoryBundle, actorUserId: string, count = 0) {
  await new AuditLogService(repos).logAuditEvent({
    workspaceId,
    userId: actorUserId,
    action: HANDLED_EVENT,
    entityType: "festival",
    entityId: `${prompt.key}:${prompt.date}`,
    newValuesJson: { festival: prompt.key, date: prompt.date, outcome, reminders: count },
  });
}

async function findPrompt(workspaceId: string, key: string, repos: RepositoryBundle): Promise<FestivalPrompt> {
  if (!FESTIVAL_BY_KEY.has(key as FestivalKey)) throw new NeedsActionError("That festival is not in the list.", 404);
  const prompt = (await festivalPrompts(workspaceId, repos)).find((p) => p.key === key);
  if (!prompt) throw new NeedsActionError("This festival card is no longer open.", 409);
  return prompt;
}

/** "Remind me about them": one open reminder per listed customer. Sends nothing. */
export async function remindForFestival(workspaceId: string, key: string, repos: RepositoryBundle = createRepositories(), actorUserId = "owner"): Promise<{ created: number }> {
  const prompt = await findPrompt(workspaceId, key, repos);
  const today = todayIstIsoDate();
  const target = minusDays(prompt.date, REMIND_DAYS_BEFORE);
  const dueOn = target > today ? target : today;
  let created = 0;
  for (const c of prompt.customers) {
    try {
      await createReminder(workspaceId, { leadId: c.leadId, dueOn, note: `${prompt.name} is on ${formatDate(`${prompt.date}T12:00:00+05:30`)}. Ask about their festive stock.`, createdBy: actorUserId }, repos);
      created++;
    } catch {
      // A customer who opted out in the meantime is skipped, never contacted.
    }
  }
  await markHandled(workspaceId, prompt, "reminded", repos, actorUserId, created);
  return { created };
}

export async function skipFestival(workspaceId: string, key: string, repos: RepositoryBundle = createRepositories(), actorUserId = "owner"): Promise<{ ok: true }> {
  const prompt = await findPrompt(workspaceId, key, repos);
  await markHandled(workspaceId, prompt, "not_this_year", repos, actorUserId);
  return { ok: true };
}
