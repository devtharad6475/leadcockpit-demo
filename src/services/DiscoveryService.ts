/**
 * DiscoveryService — noticing what a buyer told us (N11, 2026-09-19, session 57).
 *
 * ── THE TWO HALVES, AND WHY ONLY ONE IS HERE ────────────────────────────────
 * The feature is "ask a new customer the things a salesperson would ask". It
 * ships in two parts, and the ORDER is the safety:
 *
 *   1. LISTEN (this file). After every inbound message, check whether the
 *      customer just told us any fact on the wanted list — anywhere in what they
 *      wrote — and write it down in their own words. Nothing is asked. Nothing
 *      the customer sees changes at all.
 *   2. ASK (not built yet). Only after listening has run against real
 *      conversations for a while and the owner has read what it captured.
 *
 * Built the other way round, the first version would have asked customers for
 * things they had already told us — which is exactly the "filling in a form"
 * feeling the whole feature exists to avoid. Listening is also the half that can
 * be judged: the owner can read what was captured and say "that is wrong",
 * before a single question has been put in front of a real buyer.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Not a CRM field-filler. The value stored is the CUSTOMER'S OWN WORDS, never a
 * code from a dropdown. "abhi Surat se le rahe hain par thoda mehnga padta hai"
 * carries more than supplier=Surat ever could, and the next reply is written by
 * a model that reads sentences.
 *
 * ── ITS RELATIONSHIP TO THE LEAD MEMORY (N4) ────────────────────────────────
 * They overlap and that is deliberate. The memory is free prose, rewritten whole
 * each time, and it is what the model READS before replying. This is a
 * structured tick-list, and it is what tells us what is still MISSING. Prose
 * cannot answer "what have we never asked this buyer?" without being read by a
 * model every time; a tick-list answers it for free.
 *
 * ── COST ────────────────────────────────────────────────────────────────────
 * One small model call per conversation, and only while something is still
 * missing. Once a buyer has told us all six, this costs nothing for the rest of
 * that relationship — the check is a comparison of two lists, done in memory.
 */
import { NeedsActionError } from "@/lib/user-errors";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { LeadDiscoveryState } from "@/lib/types";
import { createRepositories } from "@/repositories";
import { LLMService } from "@/llm/LLMService";
import { withLeadMemoryWrite } from "./LeadMemoryWriteService";
import {
  DISCOVERY_MAX_FACTS_PER_LIST,
  checklistForLead,
  describeDiscoveryState,
  missingFacts,
  normaliseSegmentKey,
  proposedDiscoveryChecklist,
  sanitiseDiscoveryFacts,
  type DiscoveryFact,
} from "@/knowledge/discovery-checklist";
import type { DiscoveryChecklistSettings, Lead } from "@/lib/types";
import { NotFoundError } from "@/lib/safe-not-found";

// Re-exported so callers have one import for the feature. The definitions live
// in the checklist module because the owner's screen needs them in a browser and
// this file pulls in the model client and the repositories.
export { missingFacts, describeDiscoveryState } from "@/knowledge/discovery-checklist";

/** A customer's own sentence, not a database code — so it is kept whole, but bounded. */
export const DISCOVERY_VALUE_MAX_CHARS = 240;

export type DiscoveryDetection = { key: string; value: string };

export type ListenResult = {
  learned: string[];
  reason?: "no_history" | "nothing_missing" | "nothing_new" | "failed";
};

export const discoveryDetectPrompt = `You read one B2B sales conversation and report ONLY what the CUSTOMER told us about their own business.

You are given a list of facts we would like to know. For each one, decide whether the customer has actually stated it.

RULES — these matter more than being helpful:
- Report a fact ONLY if the customer said it themselves. Never from what WE said, never from the company name, never from a guess.
- Use the customer's OWN WORDS, trimmed to the relevant part. Do not translate, do not tidy, do not convert units.
- "Maybe", "let me check", "I will tell you later" is NOT an answer. Leave it out.
- If the customer said nothing about a fact, leave it out entirely. An empty list is a correct and common answer.`;

export type ListenOptions = {
  /**
   * Test seam: conversation text + wanted facts -> what the customer stated.
   *
   * Without it a golden either bills a real provider or runs against the mock,
   * whose reply contains no facts — so the test would pass while proving only
   * that nothing happened. Same seam, and same reason, as N4's summariser.
   */
  detect?: (history: string, wanted: DiscoveryFact[]) => Promise<DiscoveryDetection[]>;
  checklist?: DiscoveryFact[];
  now?: () => Date;
};

/**
 * Look at this lead's conversation and write down anything new they told us.
 *
 * Never throws. It runs AFTER the customer has been answered, so a failure here
 * must cost the conversation nothing.
 */
export async function listenForDiscoveryFacts(
  workspaceId: string,
  leadId: string,
  repos: RepositoryBundle = createRepositories(),
  options: ListenOptions = {},
): Promise<ListenResult> {
  try {
    const lead = await repos.lead.getLeadById(workspaceId, leadId);
    if (!lead) return { learned: [], reason: "no_history" };
    // N12: THIS lead's list — the owner's spine, the segment for its buyer
    // type, and any lines added to it alone. Not a fixed six.
    const checklist = options.checklist ?? (await resolveChecklistForLead(workspaceId, lead, repos));

    const state: LeadDiscoveryState = { ...(lead.discoveryState || {}) };
    const wanted = missingFacts(state, checklist);
    // Nothing missing means nothing to look for. Checked BEFORE the history is
    // gathered, because a buyer who has told us everything is exactly the buyer
    // we talk to most — and that is the conversation that would otherwise pay
    // for a model call on every single message, forever.
    if (!wanted.length) return { learned: [], reason: "nothing_missing" };

    // Discovery may learn only from actual inbound messages, never an outgoing
    // promise, a rejected draft or a model paraphrase. Keep the complete text.
    const replies = (await repos.reply.listByLead(workspaceId, leadId))
      .filter(reply => reply.workspaceId === workspaceId && reply.leadId === leadId && reply.rawText?.trim());
    if (!replies.length) return { learned: [], reason: "no_history" };
    const history = replies.map(reply => `Customer replied: ${reply.rawText}`).join("\n");
    const detected = await (options.detect ?? defaultDetect(workspaceId, repos))(history, wanted);

    return await withLeadMemoryWrite(workspaceId, leadId, repos, async () => {
    const fresh = await repos.lead.getLeadById(workspaceId, leadId);
    if (!fresh) return { learned: [], reason: "no_history" as const };
    const state: LeadDiscoveryState = { ...(fresh.discoveryState || {}) };
    const currentChecklist = options.checklist ?? await resolveChecklistForLead(workspaceId, fresh, repos);
    const at = (options.now ?? (() => new Date()))().toISOString();
    const learned: string[] = [];
    for (const item of detected || []) {
      const fact = currentChecklist.find((entry) => entry.key === item?.key);
      // A key we did not ask about is discarded rather than stored. Models
      // invent plausible field names, and an unknown key would sit in the state
      // forever: never shown, never asked, never cleaned up.
      if (!fact) continue;
      // Already answered wins. We only asked about missing facts, so this is a
      // model returning something extra — and a second answer overwriting the
      // first would let a passing mention quietly replace what the customer
      // actually stated. Changes over time are the prose memory's job.
      if (state[fact.key]?.answeredAt || state[fact.key]?.forgottenAt || state[fact.key]?.ownerEditedAt) continue;
      const value = String(item?.value ?? "").trim().slice(0, DISCOVERY_VALUE_MAX_CHARS);
      if (!value) continue;
      const evidence = replies.find(reply => reply.rawText.includes(value));
      if (!evidence) continue;
      // The label travels with the answer. If the owner later removes this
      // question from the list, what the customer told us is still on the lead
      // and still readable — it just stops being asked about.
      state[fact.key] = { ...state[fact.key], value, answeredAt: at, label: fact.label, sourceReplyId: evidence.id };
      learned.push(fact.key);
    }

    if (!learned.length) return { learned: [], reason: "nothing_new" };

    await repos.lead.updateLead(workspaceId, leadId, { discoveryState: state });
    return { learned };
    });
  } catch (error) {
    console.warn(
      `[discovery] could not read facts for ${leadId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { learned: [], reason: "failed" };
  }
}

/** The real detector, through the product's one metered choke point. */
function defaultDetect(workspaceId: string, repos: RepositoryBundle) {
  return async (history: string, wanted: DiscoveryFact[]): Promise<DiscoveryDetection[]> => {
    const list = wanted.map((fact) => `- ${fact.key}: ${fact.lookFor}`).join("\n");
    const result = await new LLMService(undefined, repos).runTask<{ facts?: DiscoveryDetection[] }>(
      "message_generation",
      { history },
      {
        workspaceId,
        overridePrompt: `${discoveryDetectPrompt}

FACTS WE WOULD LIKE TO KNOW:
${list}

CONVERSATION:
${history}

Return JSON: {"facts": [{"key": "<one of the keys above>", "value": "<the customer's own words>"}]}`,
      },
    );
    return Array.isArray(result.output?.facts) ? result.output.facts : [];
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// N12 (2026-09-23, session 58) — the owner's list, and a lead's own lines.
// ─────────────────────────────────────────────────────────────────────────────

/** The list that applies to this lead right now. Two point reads, no model. */
export async function resolveChecklistForLead(
  workspaceId: string,
  lead: Pick<Lead, "buyerType" | "discoveryExtras"> | undefined,
  repos: RepositoryBundle = createRepositories(),
): Promise<DiscoveryFact[]> {
  const [settings, profile] = await Promise.all([
    repos.whatsAppAgentSettings.getByWorkspace(workspaceId),
    repos.businessProfile.getByWorkspace(workspaceId),
  ]);
  return checklistForLead(settings?.discoveryChecklist, lead, profile?.businessType);
}

/** More buyer types than this is a sign the field holds free text, not types. */
export const DISCOVERY_MAX_SEGMENTS = 30;

export type DiscoveryChecklistView = {
  spine: DiscoveryFact[];
  segments: Record<string, DiscoveryFact[]>;
  /** False until the owner saves anything. The screen says "proposed" while it is. */
  decided: boolean;
  /** Buyer types actually on this workspace's leads, so the owner picks rather than guesses spellings. */
  buyerTypes: string[];
};

export async function getDiscoveryChecklist(
  workspaceId: string,
  repos: RepositoryBundle = createRepositories(),
): Promise<DiscoveryChecklistView> {
  const [settings, profile, leads] = await Promise.all([
    repos.whatsAppAgentSettings.getByWorkspace(workspaceId),
    repos.businessProfile.getByWorkspace(workspaceId),
    repos.lead.listLeads(workspaceId),
  ]);
  const saved = settings?.discoveryChecklist;
  const buyerTypes = [...new Set(leads.map((lead) => normaliseSegmentKey(lead.buyerType)).filter(Boolean))].sort();
  if (!saved?.decidedAt) {
    return { spine: proposedDiscoveryChecklist(profile?.businessType), segments: {}, decided: false, buyerTypes };
  }
  return { spine: saved.spine || [], segments: saved.segments || {}, decided: true, buyerTypes };
}

/**
 * Save the owner's list. Whatever they save stands — including an empty one.
 *
 * Keys the screen sends back are KEPT: answers are stored per key on every lead,
 * so a reworded question must keep its key or every answer to it is orphaned.
 */
export async function saveDiscoveryChecklist(
  workspaceId: string,
  input: { spine?: unknown; segments?: unknown },
  repos: RepositoryBundle = createRepositories(),
): Promise<DiscoveryChecklistView> {
  // 2026-09-26 (break test): a request with no list, or a wrong-shaped one,
  // used to save an EMPTY checklist — silently deleting every line the owner
  // wrote. An empty list is still allowed; it has to be sent as one.
  if (!Array.isArray(input.spine)) throw new NeedsActionError("The checklist lines were not sent as a list, so nothing was changed.", 400);
  if (input.segments !== undefined && (typeof input.segments !== "object" || input.segments === null || Array.isArray(input.segments))) {
    throw new NeedsActionError("The buyer-type lines were not sent in the right form, so nothing was changed.", 400);
  }
  const spine = sanitiseDiscoveryFacts(input.spine);
  const spineKeys = new Set(spine.map((fact) => fact.key));
  const segments: Record<string, DiscoveryFact[]> = {};
  const rawSegments = input.segments && typeof input.segments === "object" ? (input.segments as Record<string, unknown>) : {};
  // Bounded: this arrives from a request body, and every segment is read on
  // every inbound message of every lead of that type.
  for (const [rawType, facts] of Object.entries(rawSegments).slice(0, DISCOVERY_MAX_SEGMENTS)) {
    const type = normaliseSegmentKey(rawType);
    if (!type) continue;
    // Keyed against the spine so a segment line can never shadow a spine
    // question. Two segments MAY share a key: a lead has one buyer type, so
    // they never apply together.
    const clean = sanitiseDiscoveryFacts(facts, spineKeys);
    if (clean.length) segments[type] = [...(segments[type] || []), ...clean].slice(0, DISCOVERY_MAX_FACTS_PER_LIST);
  }
  const discoveryChecklist: DiscoveryChecklistSettings = { spine, segments, decidedAt: new Date().toISOString() };
  await repos.whatsAppAgentSettings.upsertForWorkspace(workspaceId, { discoveryChecklist });
  return getDiscoveryChecklist(workspaceId, repos);
}

/** One row on the lead's panel. */
export type LeadDiscoveryRow = {
  key: string;
  label: string;
  value?: string;
  known: boolean;
  /** Added to this lead alone, so it can be removed from here. */
  onlyThisLead: boolean;
  /** Answered, but the question is no longer on the owner's list. */
  noLongerAsked?: boolean;
  ownerEditedAt?: string;
  forgottenAt?: string;
  evidence?: { replyId: string; body: string; happenedAt: string };
};

export async function getLeadDiscovery(
  workspaceId: string,
  leadId: string,
  repos: RepositoryBundle = createRepositories(),
): Promise<{ rows: LeadDiscoveryRow[]; stillUnknown: string[] }> {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  if (!lead) throw new NotFoundError("Lead not found");
  const checklist = await resolveChecklistForLead(workspaceId, lead, repos);
  const own = new Set((lead.discoveryExtras || []).map((fact) => fact.key));
  const listed = new Set(checklist.map((fact) => fact.key));
  const rows: LeadDiscoveryRow[] = describeDiscoveryState(lead.discoveryState, checklist)
    .map((row) => ({ ...row, onlyThisLead: own.has(row.key) }));
  // What the customer told us about a question the owner has since removed.
  // The customer still said it; hiding it would lose information the owner
  // never asked to lose.
  for (const [key, entry] of Object.entries(lead.discoveryState || {})) {
    if (listed.has(key) || (!entry?.forgottenAt && (!entry?.answeredAt || !entry.value))) continue;
    rows.push({ key, label: entry.label || key.replace(/_/g, " "), value: entry.value, known: Boolean(entry.answeredAt && entry.value), onlyThisLead: false, noLongerAsked: true });
  }
  const replies = rows.some(row => lead.discoveryState?.[row.key]?.sourceReplyId)
    ? await repos.reply.listByLead(workspaceId, leadId) : [];
  for (const row of rows) {
    const entry = lead.discoveryState?.[row.key];
    row.ownerEditedAt = entry?.ownerEditedAt;
    row.forgottenAt = entry?.forgottenAt;
    const reply = replies.find(reply => reply.id === entry?.sourceReplyId && reply.workspaceId === workspaceId && reply.leadId === leadId);
    if (reply) row.evidence = { replyId: reply.id, body: reply.rawText, happenedAt: reply.createdAt };
  }
  return { rows, stillUnknown: missingFacts(lead.discoveryState, checklist).map((fact) => fact.label) };
}

/** Correct one existing fact, pause its capture, or deliberately resume it. */
export async function changeLeadDiscoveryFact(workspaceId: string, leadId: string, key: string,
  input: { action?: unknown; value?: unknown }, actorUserId: string, repos: RepositoryBundle = createRepositories()) {
  if (!['correct', 'forget', 'resume'].includes(String(input.action))) throw new NeedsActionError('Choose correct, remove remembered fact or resume remembering.', 400);
  if (input.action === 'correct' && (typeof input.value !== 'string' || !input.value.trim() || input.value.trim().length > DISCOVERY_VALUE_MAX_CHARS)) {
    throw new NeedsActionError(`Write a fact between 1 and ${DISCOVERY_VALUE_MAX_CHARS} characters.`, 400);
  }
  return withLeadMemoryWrite(workspaceId, leadId, repos, async () => {
    const save = async () => {
      const lead = await repos.lead.getLeadById(workspaceId, leadId);
      if (!lead) throw new NotFoundError('Customer not found');
      const checklist = await resolveChecklistForLead(workspaceId, lead, repos);
      const previous = lead.discoveryState?.[key];
      const fact = checklist.find(fact => fact.key === key);
      if (!fact && !previous) throw new NotFoundError('Customer fact not found');
      const at = new Date().toISOString(), label = fact?.label || previous?.label || key.replace(/_/g, ' ');
      const entry: LeadDiscoveryState[string] = input.action === 'correct'
        ? { label, value: (input.value as string).trim(), answeredAt: at, ownerEditedAt: at, ...(previous?.sourceReplyId ? { sourceReplyId: previous.sourceReplyId } : {}) }
        : input.action === 'forget' ? { label, forgottenAt: at } : { label };
      await repos.lead.updateLead(workspaceId, leadId, { discoveryState: { ...lead.discoveryState, [key]: entry } });
      await repos.auditLog.create({ workspaceId, actorUserId, eventType: `lead.discovery_fact_${input.action}`, entityType: 'lead', entityId: leadId,
        payload: { key, label, previous: previous || {}, current: entry }, createdAt: at });
      return getLeadDiscovery(workspaceId, leadId, repos);
    };
    return repos.withTransaction ? repos.withTransaction(save) : save();
  });
}

/**
 * Add a line to ONE lead's list — "ask whether the sample reached".
 *
 * Keyed against the rest of this lead's list, so it cannot collide with a
 * spine or segment question and silently replace it.
 */
export async function addLeadDiscoveryLine(
  workspaceId: string,
  leadId: string,
  label: string,
  repos: RepositoryBundle = createRepositories(),
) {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  if (!lead) throw new NotFoundError("Lead not found");
  if (!String(label || "").trim()) // Worded for the API error mapper, which classifies by message: "cannot"
    // reads as the caller's mistake (400), not a server fault (500).
    throw new Error("Cannot add an empty line. Write what you want to find out.");
  const current = lead.discoveryExtras || [];
  if (current.length >= DISCOVERY_MAX_FACTS_PER_LIST) {
    throw new Error(`Cannot add more than ${DISCOVERY_MAX_FACTS_PER_LIST} lines to one lead. Remove one first.`);
  }
  const general = await resolveChecklistForLead(workspaceId, { buyerType: lead.buyerType }, repos);
  const extras = sanitiseDiscoveryFacts([...current, { label }], new Set(general.map((fact) => fact.key)));
  await repos.lead.updateLead(workspaceId, leadId, { discoveryExtras: extras });
  return getLeadDiscovery(workspaceId, leadId, repos);
}

export async function removeLeadDiscoveryLine(
  workspaceId: string,
  leadId: string,
  key: string,
  repos: RepositoryBundle = createRepositories(),
) {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  if (!lead) throw new NotFoundError("Lead not found");
  const extras = (lead.discoveryExtras || []).filter((fact) => fact.key !== key);
  // Any answer the customer already gave stays on the lead. Removing a
  // question is not the same as forgetting what they said.
  await repos.lead.updateLead(workspaceId, leadId, { discoveryExtras: extras });
  return getLeadDiscovery(workspaceId, leadId, repos);
}
