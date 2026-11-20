/**
 * ActivityLogService — "who did what", in plain words (2026-09-28, feature
 * book #14). Rules: docs/LOGIC.md "2026-09-28 — ACTIVITY LOG".
 *
 * The system already writes an audit row for most things that happen. This
 * turns those rows (plus the AI's own automatic replies, which live in the
 * reply log) into one sentence each for the owner:
 *
 *     WHO   — a person's name, "The AI", "The daily routine" or "The system"
 *     WHAT  — plain words ("approved the answer to …", "sent a reply to …")
 *     WHEN  — India time: "today 10:42", "yesterday 18:05", "12 Sep"
 *
 * Safety: a sentence is built only from fixed wording plus a few named,
 * owner-meaningful fields (a customer's name, a quote number, a question's
 * text). Raw payloads, ids, keys and tokens never reach the text; the few
 * free-text fields that are shown (an owner's note, a cancel reason) are
 * redacted and shortened first. An event type nobody mapped gets a safe
 * generic sentence, never its code.
 */
import type { AuditLog, AutoReplyLog, JsonRecord } from "@/lib/types";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { displayOrderStatus, displayQuoteStatus, displayReplyClassification } from "@/lib/display-labels";
import { redactSecretsFromObject } from "@/lib/secret-redaction";

export type ActivityKind = "customers" | "knowledge" | "money" | "team" | "settings" | "other";
export type ActorKind = "person" | "ai" | "routine" | "system";

export const ACTIVITY_KINDS: ActivityKind[] = ["customers", "knowledge", "money", "team", "settings", "other"];

export type ActivityItem = {
  /** Opaque row key for the list; never shown. */
  key: string;
  at: string;
  when: string;
  who: string;
  actorKind: ActorKind;
  /** Only for people: used by the person filter. Never shown as text. */
  personId?: string;
  kind: ActivityKind;
  /** The action, starting lower-case: "approved Shree Textiles". */
  what: string;
  /** who + what, ready to show. */
  sentence: string;
};

export type ActivityPage = {
  items: ActivityItem[];
  /** Pass back as `before` for the next page; absent on the last page. */
  nextBefore?: string;
  people: Array<{ id: string; name: string }>;
};

export type ActivityQuery = {
  /** "" / "all" | "people" | "ai" (the AI, the daily routine and the system) | a person's id */
  who?: string;
  kind?: string;
  before?: string;
  limit?: number;
  now?: Date;
};

// ─── Normalised rows ────────────────────────────────────────────────────────

type Row = {
  id: string;
  at: string;
  eventType: string;
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  payload: JsonRecord;
};

/**
 * Rows that record plumbing, not an action anyone took. Delivery receipts
 * arrive several times per message and would bury everything else.
 */
const HIDDEN_TYPES = new Set(["whatsapp.status_received", "smoke_test_event", "probe.seeded", "test"]);

const AUTOMATIC_ACTORS = new Set(["", "system", "agent", "ai", "scheduler"]);
const OWNER_ALIASES = new Set(["owner", "user_owner"]);

// ─── Context passed to each sentence ────────────────────────────────────────

type Ctx = {
  row: Row;
  /** The customer this row is about ("Shree Textiles"), or "a customer". */
  customer: string;
  quote: string;
  order: string;
  question?: string;
  n: (key: string) => number | undefined;
  s: (key: string) => string | undefined;
  b: (key: string) => boolean | undefined;
};

type Rule = {
  kind: ActivityKind;
  /** Who did it when the row has no person on it. */
  auto?: "ai" | "routine" | "system";
  say: (c: Ctx) => string;
};

const count = (n: number | undefined, one: string, many: string) =>
  typeof n === "number" ? `${n} ${n === 1 ? one : many}` : many;

const ROLE_WORDS: Record<string, string> = { owner: "the owner", admin: "an admin", sales_member: "a sales member", viewer: "a viewer" };
const role = (r?: string) => (r && ROLE_WORDS[r]) || "a team member";

const PAUSE_WHY: Record<string, string> = {
  complaint: "after a complaint",
  opted_out: "after a customer asked not to be contacted",
  owner_marked: "after you marked one as wrong",
};

const topic = (t?: string) => (t ? displayReplyClassification(t).toLowerCase() : "customer");

export const RULES: Record<string, Rule> = {
  // ── Customers ──
  "lead.created": { kind: "customers", auto: "ai", say: (c) => `added ${c.customer} as a customer` },
  "lead.csv_imported": { kind: "customers", say: (c) => `imported ${count(c.n("importedCount") ?? c.n("created") ?? c.n("count"), "customer", "customers")} from a spreadsheet` },
  "lead.discovery.completed": { kind: "customers", auto: "ai", say: () => "finished looking for new customers" },
  "prospecting.daily_run": { kind: "customers", auto: "routine", say: () => "looked for new customers" },
  "lead.approved": { kind: "customers", say: (c) => `approved ${c.customer}` },
  "lead.auto_approved": { kind: "customers", auto: "routine", say: (c) => `approved ${c.customer} automatically` },
  "lead.rejected": { kind: "customers", say: (c) => `turned down ${c.customer}` },
  "lead.enriched": { kind: "customers", auto: "ai", say: (c) => `filled in more details about ${c.customer}` },
  "lead.enrichment_requested": { kind: "customers", say: (c) => `asked for more details about ${c.customer}` },
  "lead.scored": { kind: "customers", auto: "ai", say: (c) => `rated how well ${c.customer} fits` },
  "lead.status_changed": { kind: "customers", say: (c) => `changed where ${c.customer} stands` },
  "lead.became_hot": { kind: "customers", auto: "ai", say: (c) => `marked ${c.customer} as a hot customer` },
  "lead.became_mql": { kind: "customers", auto: "ai", say: (c) => `marked ${c.customer} as a promising customer` },
  "lead.became_sql": { kind: "customers", auto: "ai", say: (c) => `marked ${c.customer} as ready to buy` },
  "lead.review_decision_created": { kind: "customers", auto: "ai", say: (c) => `suggested whether to take on ${c.customer}` },
  "lead.review_recommended": { kind: "customers", auto: "ai", say: (c) => `suggested whether to take on ${c.customer}` },
  "lead.marked_do_not_contact": { kind: "customers", say: (c) => `marked ${c.customer} as do not contact` },
  "lead.do_not_contact_matched": { kind: "customers", auto: "system", say: (c) => `skipped ${c.customer} because they asked not to be contacted` },
  "lead.memory_edited": { kind: "customers", say: (c) => `edited the notes about ${c.customer}` },
  "lead.agent_action_plan_created": { kind: "customers", auto: "ai", say: (c) => `planned the next steps with ${c.customer}` },
  "message.generated": { kind: "customers", auto: "ai", say: (c) => `wrote a draft message for ${c.customer}` },
  "message.approved": { kind: "customers", say: (c) => `approved a message to ${c.customer}` },
  "festival.prompt_handled": { kind: "customers", say: (c) => c.s("outcome") === "reminded" ? `set festival reminders for ${count(c.n("reminders"), "customer", "customers")}` : "skipped this year's festival reminders" },
  "message.sent_by_owner": { kind: "customers", say: (c) => `sent a reply to ${c.customer} from their own phone` },
  "message.approved_partial": { kind: "customers", say: (c) => `approved a message to ${c.customer}` },
  "message.rejected": { kind: "customers", say: (c) => `turned down a draft message to ${c.customer}` },
  "message.send_failed": { kind: "customers", auto: "system", say: (c) => `tried to send a message to ${c.customer}, but it did not go through` },
  "outreach.marked_sent": { kind: "customers", say: (c) => `marked a message to ${c.customer} as sent` },
  "reply.created": { kind: "customers", auto: "system", say: (c) => `received a message from ${c.customer}` },
  "reply.classified": { kind: "customers", auto: "ai", say: (c) => `sorted a message from ${c.customer}` },
  "auto_reply.held_for_review": { kind: "customers", auto: "ai", say: (c) => `held a reply to ${c.customer} for you to check` },
  "auto_reply.sent": { kind: "customers", auto: "ai", say: (c) => `sent a reply to ${c.customer} — ${topic(c.s("topic"))}` },
  "auto_reply.acknowledged": { kind: "customers", auto: "ai", say: (c) => `sent ${c.customer} a short "we will get back to you" message` },
  "task.followup_due": { kind: "customers", auto: "system", say: (c) => `flagged that a follow-up with ${c.customer} is due` },
  "consent_basis_changed": { kind: "customers", say: (c) => `updated the permission to contact ${c.customer}` },
  "dnc_registered": { kind: "customers", say: (c) => `added ${c.customer} to the do-not-contact list` },
  "dnc_removed": { kind: "customers", say: (c) => `took ${c.customer} off the do-not-contact list` },
  "customer_erased": { kind: "customers", say: () => "deleted a customer's personal data at their request" },
  "customer_erased_partial": { kind: "customers", auto: "system", say: () => "started deleting a customer's personal data, but it did not finish — please check" },
  "media.customer_photo": { kind: "customers", auto: "system", say: (c) => `received a photo from ${c.customer}` },
  "media.customer_voice_note": { kind: "customers", auto: "system", say: (c) => `received a voice note from ${c.customer}` },
  "media.erased_with_lead": { kind: "customers", say: () => "deleted a customer's photos and files along with their data" },
  "whatsapp.dry_run_completed": { kind: "customers", auto: "ai", say: () => "ran a WhatsApp practice run (nothing was sent)" },
  "campaign.created": { kind: "customers", say: () => "created a campaign" },
  "campaign.approved": { kind: "customers", say: () => "approved a campaign" },
  "campaign.completed": { kind: "customers", auto: "system", say: () => "finished a campaign" },
  "campaign.learning_generated": { kind: "customers", auto: "ai", say: () => "wrote up what a campaign taught us" },
  "copilot.campaign_planned": { kind: "customers", say: () => "planned a campaign with the assistant" },
  "copilot.campaign_learning": { kind: "customers", say: () => "reviewed how a campaign went with the assistant" },
  "copilot.reply_drafted": { kind: "customers", say: (c) => `drafted a reply to ${c.customer} with the assistant` },
  "copilot.lead_review_run": { kind: "customers", say: () => "reviewed new customers with the assistant" },
  "copilot.voc_run": { kind: "customers", say: () => "asked the assistant what customers are saying" },
  "icp.generated": { kind: "customers", auto: "ai", say: () => "described the ideal customer" },
  "copilot.icp_generated": { kind: "customers", say: () => "described the ideal customer with the assistant" },
  "icp.selected": { kind: "customers", say: () => "chose which kind of customer to look for" },

  // ── Knowledge ──
  "knowledge.question_answer.edited": {
    kind: "knowledge",
    say: (c) => {
      const about = c.question ? `the answer to “${c.question}”` : "an answer";
      const prev = c.row.payload.previous as JsonRecord | undefined;
      const next = c.row.payload.next as JsonRecord | undefined;
      const before = String(prev?.answer ?? "").trim();
      const after = String(next?.answer ?? "").trim();
      if (!after) return `cleared ${about}`;
      if (before === after) return `approved ${about}`;
      return `changed ${about}`;
    },
  },
  "knowledge.safe_answers.bulk_approved": { kind: "knowledge", say: (c) => `approved ${count(c.n("approvedCount"), "answer", "answers")} at once` },
  "knowledge.manual_answer.mapped": { kind: "knowledge", say: (c) => `added ${count(c.n("mappedCount"), "answer", "answers")}` },
  "knowledge.extraction.questions_answered": { kind: "knowledge", auto: "ai", say: (c) => `read a document and filled in ${count(c.n("answeredCount"), "answer", "answers")}` },
  "knowledge.questions_extracted": { kind: "knowledge", auto: "ai", say: () => "found questions to answer in a document" },
  "knowledge.synced": { kind: "knowledge", auto: "system", say: () => "updated what the AI knows" },
  "knowledge.document_created": { kind: "knowledge", say: () => "added a document to the knowledge base" },
  "knowledge.document_deleted": { kind: "knowledge", say: () => "removed a document from the knowledge base" },
  "knowledge.answer_added": { kind: "knowledge", say: () => "added an answer to the knowledge base" },
  "knowledge.chunk.retired": { kind: "knowledge", say: () => "marked a piece of knowledge as out of date" },
  "knowledge.chunk.restored": { kind: "knowledge", say: () => "brought back a piece of knowledge" },
  "copilot.fact_offered": { kind: "knowledge", say: () => "offered a new fact for the knowledge base" },
  "unknown_question.created": { kind: "knowledge", auto: "ai", say: () => "noted a customer question it could not answer" },
  "business_extraction.generated": { kind: "knowledge", auto: "ai", say: () => "read your business details from a source" },
  "business_profile.created": { kind: "knowledge", say: () => "created the business profile" },
  "business_profile.approved": { kind: "knowledge", say: () => "approved the business profile" },
  "business_profile.synced_to_questions": { kind: "knowledge", say: () => "copied the business profile into the answers" },
  "structured_settings.synced_to_questions": { kind: "knowledge", say: () => "copied the business settings into the answers" },
  "settings.conflicts_created": { kind: "knowledge", auto: "ai", say: () => "found details that disagree and need your check" },
  "website_crawl.consent_given": { kind: "knowledge", say: () => "allowed the company website to be read" },
  "website_crawl.started": { kind: "knowledge", say: () => "started reading the company website" },
  "website_crawl.extraction_review_required": { kind: "knowledge", auto: "ai", say: () => "found details on the website that need your check" },
  "market_research_run": { kind: "knowledge", auto: "ai", say: () => "researched the market" },
  "copilot.research_run": { kind: "knowledge", say: () => "researched the market with the assistant" },
  "product_research.generated": { kind: "knowledge", auto: "ai", say: () => "researched products and buyers" },
  "media.deleted": { kind: "knowledge", say: () => "deleted a catalogue file" },

  // ── Money ──
  "quote.status_change": { kind: "money", say: (c) => `marked ${c.quote} as ${displayQuoteStatus(c.s("status") || "").toLowerCase() || "changed"}` },
  "quote.converted": { kind: "money", say: (c) => `turned ${c.quote} into an order` },
  "quote.superseded": { kind: "money", say: (c) => `replaced ${c.quote} with a new quote` },
  "copilot.quote_drafted": { kind: "money", say: (c) => `drafted a quote for ${c.customer} with the assistant` },
  "copilot.quote_approved": { kind: "money", say: (c) => `approved ${c.quote}` },
  "order.status_change": { kind: "money", say: (c) => `marked ${c.order} as ${displayOrderStatus(c.s("status") || "").toLowerCase() || "changed"}` },
  "order.cancelled": { kind: "money", say: (c) => `cancelled ${c.order}` },
  "order_cancelled": { kind: "money", say: (c) => `cancelled ${c.order}` },
  "price_change_notified": {
    kind: "money",
    say: (c) => `told ${count(c.n("sentCount"), "customer", "customers")} about a new price${c.s("productName") ? ` for ${c.s("productName")}` : ""}`,
  },

  // ── Team ──
  "invite.created": { kind: "team", say: (c) => `invited ${c.s("inviteeEmail") || "someone"} to join as ${role(c.s("role"))}` },
  "invite.accepted": { kind: "team", say: (c) => `joined the team as ${role(c.s("role"))}` },
  "invite.revoked": { kind: "team", say: (c) => `cancelled the invitation for ${c.s("inviteeEmail") || "someone"}` },
  "workspace.signup": { kind: "team", say: () => "created this company's account" },
  "workspace.provisioned": { kind: "team", auto: "system", say: () => "set up this company's account" },
  "workspace.created": { kind: "team", auto: "system", say: () => "set up this company's account" },
  "email.verified": { kind: "team", say: () => "confirmed their email address" },

  // ── Settings ──
  "kill_switch_toggled": {
    kind: "settings",
    say: (c) => (c.b("newValue") ? "pressed the emergency stop — all automatic actions stopped" : "switched automatic actions back on"),
  },
  "auto_send_toggle_changed": {
    kind: "settings",
    say: (c) => (c.b("newValue") ? "switched on automatic first messages" : "switched off automatic first messages"),
  },
  "auto_reply.kind_switched_off": {
    kind: "settings",
    auto: "system",
    say: (c) => `switched off automatic ${topic(c.s("topic") || c.row.entityId)} replies ${PAUSE_WHY[c.s("trigger") || ""] || "after a problem"}`,
  },
  "owner_notify_settings_changed": { kind: "settings", say: () => "changed the WhatsApp summary and alert settings" },
  "ai.usage_limit_changed": { kind: "settings", say: () => "changed the daily AI limits" },
  "ai.credential.removed": { kind: "settings", say: () => "removed a key for an AI service" },
  "ai_settings.updated": { kind: "settings", say: () => "changed the AI settings" },
  "integration.connected": { kind: "settings", say: () => "connected an outside service" },
  "workspace.reset": { kind: "settings", say: () => "reset the company's data" },
  "workspace.restored": { kind: "settings", say: () => "restored the company's data from a backup" },

  // ── Other ──
  "insight_note": { kind: "other", say: (c) => (c.s("note") ? `wrote a note: “${c.s("note")}”` : "wrote a note") },
  "digest_sent": { kind: "other", auto: "routine", say: () => "prepared the morning summary" },
  "owner_whatsapp_message": {
    kind: "other",
    auto: "routine",
    say: (c) => {
      const what = c.s("kind") === "alert" ? "an urgent alert" : "the morning summary";
      return c.s("status") === "sent" ? `sent you ${what} on WhatsApp` : `could not send you ${what} on WhatsApp`;
    },
  },
  "demo.seeded": { kind: "other", auto: "system", say: () => "loaded the sample company" },
};

/** The generic sentence for a type nobody mapped. Never the type's code. */
const GENERIC: Rule = { kind: "other", auto: "system", say: () => "made a change" };

export function ruleFor(eventType: string): Rule {
  return RULES[eventType] ?? GENERIC;
}

// ─── Payload reading (named fields only) ────────────────────────────────────

/** Looks in the payload itself and the three AuditLogService envelopes. */
function field(payload: JsonRecord, key: string): unknown {
  for (const layer of [payload, payload.newValuesJson, payload.metadataJson, payload.oldValuesJson]) {
    if (layer && typeof layer === "object" && !Array.isArray(layer) && key in (layer as JsonRecord)) {
      return (layer as JsonRecord)[key];
    }
  }
  return undefined;
}

const MAX_TEXT = 120;
/** Free text an owner typed: secrets masked, anything key-like dropped, shortened. */
export function safeText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const cleaned = String(redactSecretsFromObject({ text: value }).text)
    .replace(/\b(sk|pk|rk|key|tok|token|secret|Bearer)[-_ ]?[A-Za-z0-9_\-]{12,}\b/gi, "[hidden]")
    .replace(/[A-Za-z0-9_\-]{32,}/g, "[hidden]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_TEXT ? `${cleaned.slice(0, MAX_TEXT - 1)}…` : cleaned;
}

// ─── WHEN (India time) ──────────────────────────────────────────────────────

const IST_MS = 5.5 * 3_600_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function whenIst(at: string, now: Date = new Date()): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "some time ago";
  const d = new Date(t + IST_MS);
  const today = new Date(now.getTime() + IST_MS);
  const dayKey = (x: Date) => x.toISOString().slice(0, 10);
  const hhmm = d.toISOString().slice(11, 16);
  if (dayKey(d) === dayKey(today)) return `today ${hhmm}`;
  if (dayKey(d) === dayKey(new Date(today.getTime() - 86_400_000))) return `yesterday ${hhmm}`;
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === today.getUTCFullYear() ? `${date} ${hhmm}` : `${date} ${d.getUTCFullYear()}`;
}

// ─── Cursor ─────────────────────────────────────────────────────────────────

const encodeCursor = (row: Row) => Buffer.from(`${row.at}\n${row.id}`).toString("base64url");
function decodeCursor(value?: string): { at: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const [at, id] = Buffer.from(value, "base64url").toString("utf8").split("\n");
    return at && id !== undefined ? { at, id } : undefined;
  } catch {
    return undefined;
  }
}
/** Newest first; ties broken by id so paging never skips or repeats. */
const newerFirst = (a: Row, b: Row) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

// ─── Collecting rows ────────────────────────────────────────────────────────

function fromAudit(log: AuditLog): Row {
  return {
    id: log.id,
    at: log.createdAt,
    eventType: log.eventType,
    actorUserId: log.actorUserId,
    entityType: log.entityType,
    entityId: log.entityId,
    payload: (log.payload && typeof log.payload === "object" ? log.payload : {}) as JsonRecord,
  };
}

/** The AI's automatic replies are recorded in the reply log, not the audit log. */
function fromReplyLog(log: AutoReplyLog): Row | undefined {
  const decided = log.retrievedContext?.decisionCategory;
  const topicCode = typeof decided === "string" && decided ? decided : log.classification;
  const base = { id: `arl_${log.id}`, at: log.createdAt || log.updatedAt || "", actorUserId: "system", entityType: "lead", entityId: log.leadId, payload: { topic: topicCode } as JsonRecord };
  if (log.status === "auto_sent") return { ...base, eventType: "auto_reply.sent" };
  if (log.acknowledgementSent) return { ...base, eventType: "auto_reply.acknowledged" };
  return undefined;
}

/**
 * The event bus mirrors some actions into the audit log a second time, with
 * no person on it. When the same action on the same record was logged by a
 * person within two minutes, the mirror is dropped so it is not shown twice
 * (once under the wrong name).
 */
function dropMirrors(rows: Row[]): Row[] {
  const MIRROR_WINDOW_MS = 120_000;
  const direct = rows.filter((r) => !isEventBusRow(r));
  return rows.filter((r) => {
    if (!isEventBusRow(r)) return true;
    const t = Date.parse(r.at);
    return !direct.some((d) => d.eventType === r.eventType && d.entityId === r.entityId && Math.abs(Date.parse(d.at) - t) <= MIRROR_WINDOW_MS);
  });
}
function isEventBusRow(r: Row): boolean {
  const meta = r.payload.metadataJson as JsonRecord | undefined;
  return Boolean(meta && typeof meta === "object" && typeof meta.eventId === "string");
}

// ─── The page ───────────────────────────────────────────────────────────────

type Person = { id: string; name: string; role?: string };

async function loadPeople(workspaceId: string, repos: RepositoryBundle): Promise<Map<string, Person>> {
  const people = new Map<string, Person>();
  const members = await repos.workspaceMember.listByWorkspace(workspaceId).catch(() => []);
  const users = await repos.user.listForWorkspace(workspaceId).catch(() => []);
  for (const u of users) people.set(u.id, { id: u.id, name: u.name?.trim() || u.email?.split("@")[0] || "A team member", role: u.role });
  for (const m of members) {
    if (!m.userId) continue;
    const existing = people.get(m.userId);
    people.set(m.userId, { id: m.userId, name: existing?.name || m.name?.trim() || m.email?.split("@")[0] || "A team member", role: m.role || existing?.role });
  }
  return people;
}

type Actor = { who: string; actorKind: ActorKind; personId?: string };

function resolveActor(row: Row, rule: Rule, people: Map<string, Person>): Actor {
  const id = (row.actorUserId || "").trim();
  if (id && people.has(id)) {
    const p = people.get(id)!;
    return { who: p.name, actorKind: "person", personId: p.id };
  }
  if (OWNER_ALIASES.has(id)) {
    const owner = [...people.values()].find((p) => p.role === "owner");
    return owner ? { who: owner.name, actorKind: "person", personId: owner.id } : { who: "The owner", actorKind: "person", personId: "owner" };
  }
  if (AUTOMATIC_ACTORS.has(id.toLowerCase())) {
    const auto = rule.auto || "system";
    return { who: auto === "ai" ? "The AI" : auto === "routine" ? "The daily routine" : "The system", actorKind: auto };
  }
  // Someone not (or no longer) in this company — never show their id.
  return { who: "Someone on your team", actorKind: "person" };
}

function matchesWho(actor: Actor, who?: string): boolean {
  if (!who || who === "all") return true;
  if (who === "people") return actor.actorKind === "person";
  if (who === "ai") return actor.actorKind !== "person";
  return actor.personId === who;
}

export async function listActivity(workspaceId: string, repos: RepositoryBundle, query: ActivityQuery = {}): Promise<ActivityPage> {
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
  const now = query.now ?? new Date();
  const kind = query.kind && (ACTIVITY_KINDS as string[]).includes(query.kind) ? (query.kind as ActivityKind) : undefined;
  const cursor = decodeCursor(query.before);

  const [audit, replyLogs, people] = await Promise.all([
    repos.auditLog.listByWorkspace(workspaceId),
    repos.autoReplyLog.listByWorkspace(workspaceId).catch(() => [] as AutoReplyLog[]),
    loadPeople(workspaceId, repos),
  ]);

  const rows = dropMirrors([
    // Defence in depth: the repos are workspace-scoped already.
    ...audit.filter((l) => l.workspaceId === workspaceId).map(fromAudit),
    ...replyLogs.filter((l) => l.workspaceId === workspaceId).map(fromReplyLog).filter((r): r is Row => Boolean(r)),
  ].filter((r) => r.at && !HIDDEN_TYPES.has(r.eventType))).sort(newerFirst);

  // Filter first (cheap), then name the subjects only for the page shown.
  const picked: Array<{ row: Row; rule: Rule; actor: Actor }> = [];
  let more = false;
  for (const row of rows) {
    if (cursor && newerFirst(row, { ...row, at: cursor.at, id: cursor.id }) <= 0) continue;
    const rule = ruleFor(row.eventType);
    if (kind && rule.kind !== kind) continue;
    const actor = resolveActor(row, rule, people);
    if (!matchesWho(actor, query.who)) continue;
    if (picked.length === limit) { more = true; break; }
    picked.push({ row, rule, actor });
  }

  const names = await subjectNames(workspaceId, repos, picked.map((p) => p.row));
  const items: ActivityItem[] = picked.map(({ row, rule, actor }) => {
    const what = rule.say(ctxFor(row, names));
    return {
      key: row.id,
      at: row.at,
      when: whenIst(row.at, now),
      who: actor.who,
      actorKind: actor.actorKind,
      ...(actor.personId ? { personId: actor.personId } : {}),
      kind: rule.kind,
      what,
      sentence: `${actor.who} ${what}.`.replace(/\.\.$/, "."),
    };
  });

  const peopleList = [...people.values()].map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    items,
    ...(more && picked.length ? { nextBefore: encodeCursor(picked[picked.length - 1].row) } : {}),
    people: peopleList,
  };
}

// ─── Naming the subject ─────────────────────────────────────────────────────

type Names = {
  leads: Map<string, string>;
  quotes: Map<string, number>;
  orders: Map<string, number>;
  questions: Map<string, string>;
};

function leadIdOf(row: Row): string | undefined {
  if (row.entityType === "lead" && row.entityId) return row.entityId;
  const v = field(row.payload, "leadId");
  return typeof v === "string" ? v : undefined;
}

async function subjectNames(workspaceId: string, repos: RepositoryBundle, rows: Row[]): Promise<Names> {
  const names: Names = { leads: new Map(), quotes: new Map(), orders: new Map(), questions: new Map() };
  const leadIds = new Set<string>();
  for (const row of rows) {
    // An erased customer is never named again.
    if (row.eventType.startsWith("customer_erased")) continue;
    const id = leadIdOf(row);
    if (id) leadIds.add(id);
  }
  await Promise.all([...leadIds].map(async (id) => {
    const lead = await repos.lead.getLeadById(workspaceId, id).catch(() => undefined);
    const name = lead?.companyName?.trim() || lead?.contactName?.trim();
    if (name) names.leads.set(id, name);
  }));
  await Promise.all(rows.map(async (row) => {
    if (!row.entityId) return;
    if (row.entityType === "quote" && typeof field(row.payload, "quoteNumber") !== "number") {
      const q = await repos.quote.getById(workspaceId, row.entityId).catch(() => undefined);
      if (q) names.quotes.set(row.entityId, q.quoteNumber);
    }
    if (row.entityType === "order" && typeof field(row.payload, "orderNumber") !== "number") {
      const o = await repos.order.getById(workspaceId, row.entityId).catch(() => undefined);
      if (o) names.orders.set(row.entityId, o.orderNumber);
    }
  }));
  if (rows.some((r) => r.entityType === "knowledge_question_answer" && r.entityId) && repos.readAll) {
    const data = await repos.readAll({ collections: ["knowledgeQuestionAnswers"] }).catch(() => undefined);
    for (const qa of data?.knowledgeQuestionAnswers ?? []) {
      if (qa.workspaceId === workspaceId && qa.question) names.questions.set(qa.id, qa.question);
    }
  }
  return names;
}

/**
 * 2026-09-29 (owner walk-through C3) — one event as a short sentence for a
 * customer's own timeline ("The AI suggested whether to take on this
 * customer"), from the same rules as the Activity page, so the two screens
 * never describe one event differently. Undefined for a type with no rule —
 * the caller must then say something plain, never the type's code.
 */
export function timelineSentence(eventType: string, payload: JsonRecord = {}): string | undefined {
  const rule = RULES[eventType];
  if (!rule) return undefined;
  const empty: Names = { leads: new Map(), quotes: new Map(), orders: new Map(), questions: new Map() };
  const ctx = { ...ctxFor({ id: "", at: "", eventType, payload }, empty), customer: "this customer" };
  const who = rule.auto === "ai" ? "The AI " : rule.auto === "routine" ? "The daily routine " : rule.auto === "system" ? "The system " : "";
  const said = rule.say(ctx);
  return who ? `${who}${said}` : said.charAt(0).toUpperCase() + said.slice(1);
}

function ctxFor(row: Row, names: Names): Ctx {
  const leadId = leadIdOf(row);
  const customer = (leadId && names.leads.get(leadId)) || "a customer";
  const quoteNo = field(row.payload, "quoteNumber");
  const orderNo = field(row.payload, "orderNumber");
  const qn = typeof quoteNo === "number" ? quoteNo : row.entityId ? names.quotes.get(row.entityId) : undefined;
  const on = typeof orderNo === "number" ? orderNo : row.entityId ? names.orders.get(row.entityId) : undefined;
  const question = row.entityType === "knowledge_question_answer" && row.entityId ? names.questions.get(row.entityId) : undefined;
  return {
    row,
    customer,
    quote: qn !== undefined ? `quote #${qn}` : "a quote",
    order: on !== undefined ? `order #${on}` : "an order",
    question: question ? safeText(question) : undefined,
    n: (key) => {
      const v = field(row.payload, key);
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    },
    // Only named, owner-meaningful text fields are ever read; each is cleaned.
    s: (key) => safeText(field(row.payload, key)),
    b: (key) => {
      const v = field(row.payload, key);
      return typeof v === "boolean" ? v : undefined;
    },
  };
}
