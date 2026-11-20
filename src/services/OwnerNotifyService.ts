/**
 * 2026-09-28 — WhatsApp messages to the OWNER's own number: the morning summary
 * and a few urgent alerts. Never to a customer, never a reply to a customer.
 * Rules: docs/LOGIC.md OWNER-WHATSAPP. Decision: D-2026-09-28-a (proposed).
 *
 *   - Off by default. The owner switches each on and gives their number.
 *   - Goes out only through the company's own connected WhatsApp, and only in a
 *     Meta-approved template (Meta allows nothing else outside the 24-hour
 *     window). Not connected, or no approved template → it stays in the app and
 *     the record says why. Nothing is ever reported as sent that was not.
 *   - The number must not belong to a customer of the company.
 *   - Alerts: at most N a day; none 21:00–08:00 IST; the rest wait for the
 *     next morning summary. Each alert at most once (a claim per alert key).
 *   - Every attempt is recorded (audit event `owner_whatsapp_message`).
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AuditLog, Workspace, WhatsAppTemplate } from "@/lib/types";
import type { WhatsAppSendProvider } from "@/providers/whatsapp/WhatsAppSendProvider";
import { createRepositories } from "@/repositories";
import { NeedsActionError } from "@/lib/user-errors";
import { timestamp } from "@/lib/db";
import { todayIstIsoDate } from "@/lib/time";
import {
  isOwnerQuietHours, normalizeOwnerWhatsappNumber, readOwnerNotifySettings, toTemplateVariable,
  MAX_ALERTS_PER_DAY_LIMIT, TICKET_ALERT_MINUTES_BEFORE, type OwnerNotifySettings,
} from "@/lib/owner-notify";
import { buildNeedsYouList, leadDisplayName, type NeedsYouList } from "@/services/NeedsYouService";
import { listNewBuyersToday } from "@/services/NewBuyersTodayService";
import { computeLiveBreach } from "@/services/TicketService";

export const OWNER_MESSAGE_EVENT = "owner_whatsapp_message";

export type OwnerAlertKind = "complaint" | "big_amount" | "customer_waiting" | "ticket_due";
export type OwnerMessageStatus =
  | "sent" | "failed" | "not_connected" | "needs_template" | "off" | "no_number"
  | "blocked_customer_number" | "held_quiet_hours" | "held_daily_limit" | "duplicate";

export type OwnerMessageResult = { status: OwnerMessageStatus; reason: string; text: string };

export type OwnerNotifyDeps = {
  resolveProvider: (workspaceId: string, repos: RepositoryBundle) => Promise<WhatsAppSendProvider>;
  now: () => Date;
};

let providerForTesting: WhatsAppSendProvider | null = null;
/** Test seam: every owner message goes through this stub instead of Meta. Pass null to restore. */
export function setOwnerNotifyProviderForTesting(provider: WhatsAppSendProvider | null): void {
  providerForTesting = provider;
}

const defaultDeps: OwnerNotifyDeps = {
  resolveProvider: async (workspaceId, repos) => {
    if (providerForTesting) return providerForTesting;
    const { WhatsAppCredentialService } = await import("@/services/WhatsAppCredentialService");
    return new WhatsAppCredentialService(repos).resolveProvider(workspaceId);
  },
  now: () => new Date(),
};

const REASONS: Record<OwnerMessageStatus, string> = {
  sent: "Sent to your WhatsApp.",
  failed: "WhatsApp did not accept the message.",
  not_connected: "Your WhatsApp is not connected, so it stayed in the app.",
  needs_template: "No Meta-approved template is chosen for this, so it stayed in the app.",
  off: "Switched off in settings, so it stayed in the app.",
  no_number: "No owner WhatsApp number is saved, so it stayed in the app.",
  blocked_customer_number: "The saved owner number belongs to one of your customers, so nothing was sent.",
  held_quiet_hours: "Quiet hours (21:00–08:00) — it waits for the morning summary.",
  held_daily_limit: "Today's alert limit was reached — it waits for the morning summary.",
  duplicate: "Already handled.",
};

function mask(number: string): string {
  return number.length > 5 ? `${number.slice(0, 3)}•••••${number.slice(-4)}` : "•••";
}

function rupees(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export type OwnerNotifyView = {
  settings: OwnerNotifySettings;
  ownerWhatsappNumber?: string;
  templates: Array<Pick<WhatsAppTemplate, "id" | "name" | "status" | "language">>;
  whatsappConnected: boolean;
  recent: Array<{ at: string; kind: string; alertKind?: string; status: string; reason: string; text: string }>;
};

export async function getOwnerNotifyView(
  workspaceId: string,
  repos: RepositoryBundle = createRepositories(),
  deps: Partial<OwnerNotifyDeps> = {},
): Promise<OwnerNotifyView> {
  const d = { ...defaultDeps, ...deps };
  const workspace = await repos.workspace.getById(workspaceId);
  const templates = await repos.whatsAppTemplate.listByWorkspace(workspaceId).catch(() => []);
  let whatsappConnected = false;
  try { whatsappConnected = (await d.resolveProvider(workspaceId, repos)).isConfigured(); } catch { whatsappConnected = false; }
  const recent = (await ownerMessageRecords(workspaceId, repos)).slice(0, 10).map((r) => ({
    at: r.createdAt,
    kind: String(r.payload.kind || ""),
    alertKind: r.payload.alertKind ? String(r.payload.alertKind) : undefined,
    status: String(r.payload.status || ""),
    reason: String(r.payload.reason || ""),
    text: String(r.payload.text || ""),
  }));
  return {
    settings: readOwnerNotifySettings(workspace?.ownerNotifySettings),
    ownerWhatsappNumber: workspace?.ownerWhatsappNumber || undefined,
    templates: templates.map((t) => ({ id: t.id, name: t.name, status: t.status, language: t.language })),
    whatsappConnected,
    recent,
  };
}

export async function saveOwnerNotifySettings(
  workspaceId: string,
  input: Record<string, unknown>,
  actorUserId: string,
  repos: RepositoryBundle = createRepositories(),
): Promise<Workspace> {
  const workspace = await repos.workspace.getById(workspaceId);
  if (!workspace) throw new NeedsActionError("Company not found.", 404);
  const current = readOwnerNotifySettings(workspace.ownerNotifySettings);
  const next: OwnerNotifySettings = { ...current };
  if ("morningSummary" in input) next.morningSummary = input.morningSummary === true;
  if ("urgentAlerts" in input) next.urgentAlerts = input.urgentAlerts === true;
  if ("bigAmountInr" in input) {
    const raw = input.bigAmountInr;
    if (raw === null || raw === "" || raw === undefined) next.bigAmountInr = undefined;
    else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new NeedsActionError("Enter the order or quote amount in rupees, for example 100000 — or leave it empty.", 400);
      next.bigAmountInr = Math.round(n);
    }
  }
  if ("maxAlertsPerDay" in input) {
    const n = Number(input.maxAlertsPerDay);
    if (!Number.isInteger(n) || n < 1 || n > MAX_ALERTS_PER_DAY_LIMIT) throw new NeedsActionError(`Alerts a day must be a whole number from 1 to ${MAX_ALERTS_PER_DAY_LIMIT}.`, 400);
    next.maxAlertsPerDay = n;
  }
  for (const key of ["summaryTemplateId", "alertTemplateId"] as const) {
    if (!(key in input)) continue;
    const id = typeof input[key] === "string" ? (input[key] as string).trim() : "";
    if (!id) { next[key] = undefined; continue; }
    const template = await repos.whatsAppTemplate.getById(workspaceId, id);
    if (!template) throw new NeedsActionError("That WhatsApp template was not found. Pick one from the list.", 400);
    next[key] = id;
  }

  let number = workspace.ownerWhatsappNumber || undefined;
  if ("ownerWhatsappNumber" in input) {
    const raw = input.ownerWhatsappNumber;
    if (raw === null || raw === "" || raw === undefined) number = undefined;
    else {
      const check = normalizeOwnerWhatsappNumber(raw);
      if (!check.ok) throw new NeedsActionError(check.message, 400);
      number = check.number;
    }
  }
  if ((next.morningSummary || next.urgentAlerts) && !number) {
    throw new NeedsActionError("Add your WhatsApp number first — the summary and alerts go only to you.", 400);
  }
  if (number && (await repos.lead.findLeadByPhone(workspaceId, number))) {
    throw new NeedsActionError("That number belongs to one of your customers. Enter your own number — these messages are for you only.", 400);
  }

  const updated = await repos.workspace.update(workspaceId, {
    ownerWhatsappNumber: number,
    ownerNotifySettings: next as unknown as Record<string, unknown>,
  });
  await repos.auditLog.create({
    workspaceId,
    eventType: "owner_notify_settings_changed",
    actorUserId,
    entityType: "workspace",
    entityId: workspaceId,
    payload: { ...next, ownerWhatsappNumber: number ? mask(number) : undefined },
  });
  return updated;
}

// ─── Sending ────────────────────────────────────────────────────────────────

async function ownerMessageRecords(workspaceId: string, repos: RepositoryBundle): Promise<AuditLog[]> {
  return (await repos.auditLog.listByWorkspace(workspaceId))
    .filter((l) => l.eventType === OWNER_MESSAGE_EVENT)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function record(
  workspaceId: string,
  repos: RepositoryBundle,
  payload: { kind: "summary" | "alert"; alertKind?: OwnerAlertKind; key: string; status: OwnerMessageStatus; text: string; to?: string; providerMessageId?: string; error?: string; day: string },
): Promise<void> {
  await repos.auditLog.create({
    workspaceId,
    eventType: OWNER_MESSAGE_EVENT,
    actorUserId: "system",
    entityType: "owner_notification",
    entityId: payload.key,
    payload: { ...payload, reason: REASONS[payload.status] + (payload.error ? ` (${payload.error})` : ""), to: payload.to ? mask(payload.to) : undefined },
  });
}

/** Claim a one-time key (an alert, or a day's summary). False when it was already claimed. */
async function claimOnce(workspaceId: string, key: string, repos: RepositoryBundle): Promise<boolean> {
  try {
    await repos.jobRun.create({ id: `owner_notify:${workspaceId}:${key}`, workspaceId, jobType: "owner_notify", status: "completed", payload: { key }, startedAt: timestamp() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deliver one message to the owner's own number — or say plainly why it stayed
 * in the app. Does not decide WHETHER to send (quiet hours, limits); callers do.
 */
async function deliver(
  workspace: Workspace,
  kind: "summary" | "alert",
  text: string,
  repos: RepositoryBundle,
  d: OwnerNotifyDeps,
): Promise<{ status: OwnerMessageStatus; to?: string; providerMessageId?: string; error?: string }> {
  const settings = readOwnerNotifySettings(workspace.ownerNotifySettings);
  if (kind === "summary" ? !settings.morningSummary : !settings.urgentAlerts) return { status: "off" };
  const check = normalizeOwnerWhatsappNumber(workspace.ownerWhatsappNumber || "");
  if (!check.ok) return { status: "no_number" };
  const to = check.number;
  // Never to a customer: the number is checked again at every send, because a
  // customer can be added with it after the owner saved it.
  if (await repos.lead.findLeadByPhone(workspace.id, to)) return { status: "blocked_customer_number", to };
  const templateId = kind === "summary" ? settings.summaryTemplateId : settings.alertTemplateId;
  const template = templateId ? await repos.whatsAppTemplate.getById(workspace.id, templateId) : undefined;
  if (!template || template.status !== "approved") return { status: "needs_template", to };
  let provider: WhatsAppSendProvider;
  try { provider = await d.resolveProvider(workspace.id, repos); } catch { return { status: "not_connected", to }; }
  if (!provider.isConfigured() || typeof provider.sendTemplateMessage !== "function") return { status: "not_connected", to };
  const result = await provider.sendTemplateMessage({
    workspaceId: workspace.id,
    to,
    templateName: template.providerTemplateId || template.name,
    language: template.language || "en_US",
    components: [{ type: "body", parameters: [{ type: "text", text: toTemplateVariable(text) }] }],
  });
  if (result.status === "sent") return { status: "sent", to, providerMessageId: result.providerMessageId };
  if (result.status === "not_configured") return { status: "not_connected", to };
  return { status: "failed", to, error: result.errorMessage };
}

// ─── Morning summary ────────────────────────────────────────────────────────

export type MorningSummaryInput = {
  list: Pick<NeedsYouList, "count" | "counts" | "items">;
  newBuyers: number;
  remindersDue: number;
  heldAlerts: number;
  link?: string;
  day: string;
};

/** The short WhatsApp text. At most 8 lines; a line only when its number is not zero. */
export function renderOwnerMorningSummary(input: MorningSummaryInput): string {
  const c = input.list.counts;
  const inr = (bucket: string) => input.list.items.filter((i) => i.bucket === bucket).reduce((sum, i) => sum + (i.amountInr || 0), 0);
  const withAmount = (count: number, amount: number) => (amount > 0 ? `${count} (${rupees(amount)})` : `${count}`);
  const date = new Date(`${input.day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  const head = input.list.count > 0
    ? `Good morning. ${input.list.count} thing${input.list.count === 1 ? "" : "s"} need${input.list.count === 1 ? "s" : ""} you today (${date}).`
    : `Good morning. Nothing needs you today (${date}).`;
  const lines = [
    head + (input.heldAlerts > 0 ? ` ${input.heldAlerts} alert${input.heldAlerts === 1 ? "" : "s"} waited for the morning.` : ""),
  ];
  const add = (count: number, line: string) => { if (count > 0) lines.push(line); };
  add(c.customer_waiting, `Customers waiting for a reply: ${c.customer_waiting}`);
  add(c.ticket, `Tickets late or due today: ${c.ticket}`);
  add(c.quote_waiting, `Quotes with no answer: ${withAmount(c.quote_waiting, inr("quote_waiting"))}`);
  add(c.order, `Orders to ship: ${withAmount(c.order, inr("order"))}`);
  add(input.remindersDue, `Reminders due today: ${input.remindersDue}`);
  add(input.newBuyers, `New buyers found: ${input.newBuyers}`);
  lines.push(input.link ? `Open: ${input.link}` : "Open LeadCockpit to see them.");
  return lines.slice(0, 8).join("\n");
}

function appLink(): string | undefined {
  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.WHATSAPP_PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(base) ? base : undefined;
}

/**
 * Build the morning summary text and send it to the owner (once per company
 * per IST day), or keep it in the app. Called by the daily routine AFTER the
 * night's work, so the numbers include it.
 */
export async function sendOwnerMorningSummary(
  workspaceId: string,
  input: { remindersDue?: number },
  repos: RepositoryBundle = createRepositories(),
  deps: Partial<OwnerNotifyDeps> = {},
): Promise<OwnerMessageResult & { count: number; newBuyers: number }> {
  const d = { ...defaultDeps, ...deps };
  const now = d.now();
  const day = todayIstIsoDate(now);
  const workspace = await repos.workspace.getById(workspaceId);
  const list = await buildNeedsYouList(workspaceId, repos, { now });
  // 2026-09-28 — "New buyers found" uses the SAME definition as the "Today's
  // new buyers" card (docs/LOGIC.md TODAY'S-NEW-BUYERS), not the raw number of
  // leads the night's search created, so the phone and the screen agree.
  const newBuyers = (await listNewBuyersToday(workspaceId, repos, { now })).count;
  const records = await ownerMessageRecords(workspaceId, repos);
  const lastSummaryAt = records.find((r) => r.payload.kind === "summary")?.createdAt || "";
  const heldAlerts = records.filter((r) => r.payload.kind === "alert" && r.payload.status !== "sent" && r.payload.status !== "off" && r.createdAt > lastSummaryAt).length;
  const text = renderOwnerMorningSummary({
    list, newBuyers, remindersDue: input.remindersDue ?? list.counts.reminder, heldAlerts, link: appLink(), day,
  });
  if (!workspace) return { status: "off", reason: REASONS.off, text, count: list.count, newBuyers };
  if (!(await claimOnce(workspaceId, `summary:${day}`, repos))) return { status: "duplicate", reason: REASONS.duplicate, text, count: list.count, newBuyers };
  const sent = await deliver(workspace, "summary", text, repos, d);
  await record(workspaceId, repos, { kind: "summary", key: `summary:${day}`, status: sent.status, text, to: sent.to, providerMessageId: sent.providerMessageId, error: sent.error, day });
  return { status: sent.status, reason: REASONS[sent.status], text, count: list.count, newBuyers };
}

// ─── Urgent alerts ──────────────────────────────────────────────────────────

/**
 * One alert to the owner. It only INFORMS — it never replies to a customer.
 * `key` makes it once-only (the same complaint never alerts twice).
 */
export async function raiseOwnerAlert(
  workspaceId: string,
  alert: { kind: OwnerAlertKind; key: string; text: string },
  repos: RepositoryBundle = createRepositories(),
  deps: Partial<OwnerNotifyDeps> = {},
): Promise<OwnerMessageResult> {
  const d = { ...defaultDeps, ...deps };
  const now = d.now();
  const day = todayIstIsoDate(now);
  const workspace = await repos.workspace.getById(workspaceId);
  const settings = readOwnerNotifySettings(workspace?.ownerNotifySettings);
  // Off → nothing is recorded; the item is on the Needs you list anyway.
  if (!workspace || !settings.urgentAlerts) return { status: "off", reason: REASONS.off, text: alert.text };
  if (!(await claimOnce(workspaceId, `alert:${alert.key}`, repos))) return { status: "duplicate", reason: REASONS.duplicate, text: alert.text };
  let status: OwnerMessageStatus;
  let extra: { to?: string; providerMessageId?: string; error?: string } = {};
  if (isOwnerQuietHours(now)) status = "held_quiet_hours";
  else {
    const sentToday = (await ownerMessageRecords(workspaceId, repos))
      .filter((r) => r.payload.kind === "alert" && r.payload.status === "sent" && r.payload.day === day).length;
    if (sentToday >= settings.maxAlertsPerDay) status = "held_daily_limit";
    else {
      const sent = await deliver(workspace, "alert", alert.text, repos, d);
      status = sent.status;
      extra = sent;
    }
  }
  await record(workspaceId, repos, { kind: "alert", alertKind: alert.kind, key: alert.key, status, text: alert.text, day, ...extra });
  return { status, reason: REASONS[status], text: alert.text };
}

/** A complaint or an abusive message just arrived. */
export async function alertOwnerOnComplaint(
  workspaceId: string,
  input: { replyId: string; category: string; leadName?: string; text: string },
  repos: RepositoryBundle = createRepositories(),
  deps: Partial<OwnerNotifyDeps> = {},
): Promise<OwnerMessageResult | undefined> {
  if (input.category !== "complaint" && input.category !== "abusive_message") return undefined;
  const who = input.leadName || "a customer";
  const what = input.category === "abusive_message" ? `An abusive message from ${who}` : `A complaint from ${who}`;
  return raiseOwnerAlert(workspaceId, {
    kind: "complaint",
    key: `complaint:${input.replyId}`,
    text: `${what} on WhatsApp: "${input.text.replace(/\s+/g, " ").slice(0, 140)}". Nothing was sent back — open LeadCockpit to reply.`,
  }, repos, deps);
}

/** A new order or quote at or above the owner's amount — unless the owner made it. */
export async function alertOwnerOnBigAmount(
  workspaceId: string,
  input: { kind: "order" | "quote"; id: string; number?: number; total: number; currencyCode?: string; leadId?: string; actorUserId?: string },
  repos: RepositoryBundle = createRepositories(),
  deps: Partial<OwnerNotifyDeps> = {},
): Promise<OwnerMessageResult | undefined> {
  if ((input.currencyCode || "INR").toUpperCase() !== "INR") return undefined;
  const workspace = await repos.workspace.getById(workspaceId);
  const settings = readOwnerNotifySettings(workspace?.ownerNotifySettings);
  if (!workspace || !settings.bigAmountInr || !(input.total >= settings.bigAmountInr)) return undefined;
  if (input.actorUserId && workspace.ownerUserId && input.actorUserId === workspace.ownerUserId) return undefined; // the owner already knows
  const lead = input.leadId ? await repos.lead.getLeadById(workspaceId, input.leadId) : undefined;
  const label = input.kind === "order" ? "order" : "quote";
  return raiseOwnerAlert(workspaceId, {
    kind: "big_amount",
    key: `big_amount:${input.kind}:${input.id}`,
    text: `A new ${label}${input.number ? ` #${input.number}` : ""} of ${rupees(input.total)}${lead ? ` for ${leadDisplayName(lead)}` : ""}. Open LeadCockpit to look at it.`,
  }, repos, deps);
}

/**
 * The time-based alerts: a customer waiting more than 2 business hours, and an
 * urgent ticket 30 minutes before its deadline. Run by a regular check (the
 * daily routine, and POST /api/internal/owner-alerts-check).
 */
export async function checkTimedOwnerAlerts(
  workspaceId: string,
  repos: RepositoryBundle = createRepositories(),
  deps: Partial<OwnerNotifyDeps> = {},
): Promise<OwnerMessageResult[]> {
  const d = { ...defaultDeps, ...deps };
  const workspace = await repos.workspace.getById(workspaceId);
  if (!workspace || !readOwnerNotifySettings(workspace.ownerNotifySettings).urgentAlerts) return [];
  const now = d.now();
  const list = await buildNeedsYouList(workspaceId, repos, { now });
  const results: OwnerMessageResult[] = [];
  for (const item of list.items) {
    if (item.bucket === "customer_waiting" && item.lead) {
      results.push(await raiseOwnerAlert(workspaceId, {
        kind: "customer_waiting",
        key: `waiting:${item.lead.id}:${item.lead.lastInboundAt}`,
        text: `${leadDisplayName(item.lead)} has waited over 2 working hours for a reply. Open LeadCockpit to answer.`,
      }, repos, d));
    }
  }
  for (const ticket of await repos.ticket.listByWorkspace(workspaceId)) {
    if (ticket.priority !== "urgent" || ticket.status === "waiting_customer") continue;
    const live = computeLiveBreach(ticket, now);
    if (!Number.isFinite(live.remainingMinutes) || live.remainingMinutes > TICKET_ALERT_MINUTES_BEFORE || live.remainingMinutes < -24 * 60) continue;
    results.push(await raiseOwnerAlert(workspaceId, {
      kind: "ticket_due",
      key: `ticket_due:${ticket.id}:${ticket.slaDueAt}`,
      text: live.breached
        ? `Urgent ticket #${ticket.ticketNumber} is past its deadline: ${ticket.subject.slice(0, 100)}.`
        : `Urgent ticket #${ticket.ticketNumber} is due in ${Math.max(0, live.remainingMinutes)} minutes: ${ticket.subject.slice(0, 100)}.`,
    }, repos, d));
  }
  return results;
}

/** Every company with alerts switched on. For the regular outside check. */
export async function checkTimedOwnerAlertsForAll(repos: RepositoryBundle = createRepositories(), deps: Partial<OwnerNotifyDeps> = {}): Promise<number> {
  let raised = 0;
  for (const workspace of await repos.workspace.listAll(false)) {
    if (!readOwnerNotifySettings(workspace.ownerNotifySettings).urgentAlerts) continue;
    try {
      raised += (await checkTimedOwnerAlerts(workspace.id, repos, deps)).filter((r) => r.status !== "duplicate" && r.status !== "off").length;
    } catch (error) {
      console.error(`[owner-alerts] check failed for ${workspace.id}:`, error instanceof Error ? error.message : error);
    }
  }
  return raised;
}
