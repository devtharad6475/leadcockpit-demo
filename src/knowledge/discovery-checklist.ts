/**
 * discovery-checklist.ts — what is worth knowing about a BUYER
 * (N11, 2026-09-18, session 57).
 *
 * ── THE DISTINCTION THIS FILE EXISTS TO HOLD ────────────────────────────────
 * This is a list of FACTS WANTED. It is not a script of questions to ask in
 * order, and the difference is the whole feature.
 *
 * A script asks question 1, then 2, then 3, whatever the customer said. People
 * feel that within two messages — it reads as a form. What a good salesperson
 * actually does is keep a short list in their head of what they would like to
 * know, answer the customer's question first, and then ask the ONE thing that is
 * missing and that fits what was just said. Never twice, and never while the
 * customer is angry or ready to buy.
 *
 * So this file holds the list. `DiscoveryService` holds the manners.
 *
 * ── WHOSE LIST THIS IS ──────────────────────────────────────────────────────
 * The operator's, ultimately — he was clear that what a business wants to know
 * about its buyers is a judgement, not something that can be researched out of
 * him. This is the SEED, so nobody faces an empty box; `N12` makes it editable
 * and adds a layer per buyer type. The business-side check sheet (`N13`) is a
 * different list with a different author, and the two must not be merged.
 *
 * ── WHY THESE SIX ───────────────────────────────────────────────────────────
 * Three came from the operator describing what he asks a new customer himself:
 * what they deal in, where they buy it now, and what is going wrong there. The
 * other three are what a quotation actually needs. Nothing here asks for
 * anything a buyer would find intrusive on a first conversation.
 */

import type { DiscoveryChecklistSettings, DiscoveryFact, LeadDiscoveryState } from "@/lib/types";

// The type lives in types.ts because workspace settings and leads both hold
// lists of these. Re-exported so feature code has one import.
export type { DiscoveryFact };

export const DEFAULT_DISCOVERY_CHECKLIST: DiscoveryFact[] = [
  {
    key: "what_they_deal_in",
    label: "What they deal in",
    lookFor: "the products or trade the customer's own business handles — what they make, resell, or use what we sell for",
    exampleAsk: "aap kis line me ho — saree, dress material ya job work?",
    priority: 1,
  },
  {
    key: "current_supplier",
    label: "Where they buy it now",
    lookFor: "any mention of who supplies them today, or a city or market they buy from",
    exampleAsk: "abhi aap kahan se le rahe ho?",
    priority: 2,
  },
  {
    key: "problem_with_current",
    label: "What is going wrong with their current supply",
    lookFor: "any complaint about their present supplier — quality, delays, price, service, inconsistency",
    exampleAsk: "abhi jo mil raha hai usme koi dikkat aa rahi hai?",
    priority: 3,
  },
  {
    key: "volume",
    label: "Roughly how much they buy",
    lookFor: "quantities, monthly or per-order volumes, or how often they buy",
    exampleAsk: "mahine me approx kitna lagta hai?",
    priority: 4,
  },
  {
    key: "buying_frequency",
    label: "How often they buy",
    lookFor: "regular, seasonal, one-time, or a stated interval",
    exampleAsk: "ye regular requirement hai ya one-time?",
    priority: 5,
  },
  {
    key: "decision_maker",
    label: "Who decides",
    lookFor: "whether this person decides, or someone else does — a partner, a purchase head, an owner",
    exampleAsk: "order final aap karte ho ya kisi aur se poochna padta hai?",
    priority: 6,
  },
];

/** Looked up by key rather than scanned, because this runs on every reply. */
const BY_KEY = new Map(DEFAULT_DISCOVERY_CHECKLIST.map((fact) => [fact.key, fact]));

export function discoveryFact(key: string): DiscoveryFact | undefined {
  return BY_KEY.get(key);
}

/**
 * The facts we still do not know about this buyer, in the order worth asking.
 *
 * Lives HERE and not in `DiscoveryService` because the owner's screen needs it,
 * and that screen runs in a browser. `DiscoveryService` pulls in the model
 * client and the repositories; importing it from a client component would drag
 * a server stack into the bundle. Pure list arithmetic belongs with the list.
 */
export function missingFacts(
  state: LeadDiscoveryState | undefined,
  checklist: DiscoveryFact[] = DEFAULT_DISCOVERY_CHECKLIST,
): DiscoveryFact[] {
  return checklist
    // "Is there an entry?" is NOT the same question as "did they answer?". A
    // fact we raised and got ignored on is still a fact we do not know, and
    // asked-and-ignored is the commonest outcome of asking anything.
    .filter((fact) => !state?.[fact.key]?.answeredAt && !state?.[fact.key]?.forgottenAt)
    .sort((a, b) => a.priority - b.priority);
}

/** What we know about this buyer, shaped for a screen and nothing else. */
export function describeDiscoveryState(
  state: LeadDiscoveryState | undefined,
  checklist: DiscoveryFact[] = DEFAULT_DISCOVERY_CHECKLIST,
): Array<{ key: string; label: string; value?: string; known: boolean }> {
  return checklist.map((fact) => ({
    key: fact.key,
    label: fact.label,
    value: state?.[fact.key]?.value,
    known: Boolean(state?.[fact.key]?.answeredAt),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// N12 (2026-09-23, session 58) — the OWNER decides the list.
//
// What is worth knowing about a buyer is a choice, not something that can be
// researched out of the owner: two zari sellers would ask different things. The
// system's job is to PROPOSE a starting list so nobody faces an empty box, and
// then to get out of the way.
// ─────────────────────────────────────────────────────────────────────────────

/** Past this the detection prompt grows for every conversation, and it is paid for every conversation. */
export const DISCOVERY_MAX_FACTS_PER_LIST = 12;
export const DISCOVERY_LABEL_MAX_CHARS = 80;
export const DISCOVERY_LOOK_FOR_MAX_CHARS = 200;

/**
 * For a seller of SERVICES the same wanted facts read differently: nobody
 * "buys" a repair contract in kilos, and the incumbent is a provider, not a
 * supplier. Same keys, so a workspace that changes its business type keeps
 * everything its leads already told it.
 */
const SERVICE_WORDING: Record<string, Pick<DiscoveryFact, "label" | "lookFor" | "exampleAsk">> = {
  what_they_deal_in: {
    label: "What their business does",
    lookFor: "what the customer's own business does, and what they need the service for",
    exampleAsk: "aapka kaam kis cheez ka hai, aur ye service kis liye chahiye?",
  },
  current_supplier: {
    label: "Who does this for them now",
    lookFor: "any mention of who provides this service to them today, or that they do it in-house",
    exampleAsk: "abhi ye kaam kaun kar raha hai aapke liye?",
  },
  problem_with_current: {
    label: "What is going wrong with the current arrangement",
    lookFor: "any complaint about their present provider — quality, delays, price, responsiveness",
    exampleAsk: "abhi jo arrangement hai usme koi dikkat?",
  },
  volume: {
    label: "Roughly how much work",
    lookFor: "size of the job — number of sites, people, hours, units, or a budget",
    exampleAsk: "kaam kitna bada hai roughly?",
  },
};

/** Loose on purpose: business type is free text an owner typed, not an enum. */
export function isServiceBusiness(businessType: string | undefined): boolean {
  return /service|consult|agency|contractor|repair|maintenance|logistic|transport|freight|install|clean|security|software/i
    .test(businessType || "");
}

/**
 * The starting list offered to an owner who has not decided one yet.
 *
 * "Proposing is not deciding": this is shown AS a proposal and used until the
 * owner saves anything — at which point their list stands, even if empty.
 */
export function proposedDiscoveryChecklist(businessType?: string): DiscoveryFact[] {
  if (!isServiceBusiness(businessType)) return DEFAULT_DISCOVERY_CHECKLIST.map((fact) => ({ ...fact }));
  return DEFAULT_DISCOVERY_CHECKLIST.map((fact) => ({ ...fact, ...(SERVICE_WORDING[fact.key] || {}) }));
}

/**
 * Buyer type is free text on the lead — "Wholesaler", "wholesaler ", "WHOLESALER".
 * A segment the owner wrote for one spelling must reach the others, or the
 * layer silently applies to some wholesalers and not the rest.
 */
export function normaliseSegmentKey(buyerType: string | undefined): string {
  return (buyerType || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** A stable key from a label, made unique against keys already taken. */
export function discoveryKeyFor(label: string, taken: Set<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "fact";
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = base + "_" + n;
  return key;
}

/**
 * Clean an owner-edited list: trim, bound, drop blanks, keep EXISTING keys,
 * mint keys only for new lines, and number priorities in the order given.
 *
 * Keys are kept because answers are stored per key on every lead. An edit that
 * minted a fresh key for a reworded label would orphan everything every buyer
 * had already told us about it.
 */
export function sanitiseDiscoveryFacts(input: unknown, alsoTaken: Set<string> = new Set()): DiscoveryFact[] {
  if (!Array.isArray(input)) return [];
  const taken = new Set(alsoTaken);
  const out: DiscoveryFact[] = [];
  for (const raw of input) {
    if (out.length >= DISCOVERY_MAX_FACTS_PER_LIST) break;
    const item = (raw && typeof raw === "object" ? raw : {}) as Partial<DiscoveryFact>;
    const label = String(item.label ?? "").trim().slice(0, DISCOVERY_LABEL_MAX_CHARS);
    if (!label) continue;
    const suppliedKey = typeof item.key === "string" ? item.key.trim() : "";
    const key = suppliedKey && /^[a-z0-9_]{1,60}$/.test(suppliedKey) && !taken.has(suppliedKey)
      ? suppliedKey
      : discoveryKeyFor(label, taken);
    taken.add(key);
    const lookFor = String(item.lookFor ?? "").trim().slice(0, DISCOVERY_LOOK_FOR_MAX_CHARS);
    out.push({
      key,
      label,
      // An owner who writes only "Do they export?" has said enough. The label
      // is what the model looks for when nothing better is given.
      lookFor: lookFor || label,
      exampleAsk: String(item.exampleAsk ?? "").trim().slice(0, DISCOVERY_LOOK_FOR_MAX_CHARS),
      priority: out.length + 1,
    });
  }
  return out;
}

/**
 * The list that applies to ONE lead: the owner's spine, plus the segment for
 * this buyer's type, plus any lines added to this lead alone.
 *
 * On a key collision the more specific layer wins — this lead, then the spine,
 * then the segment. The same fact defined twice is still one fact. (A line added
 * to one lead is keyed against that lead's list, so it cannot normally collide.)
 *
 * Lines added to a single lead come FIRST. Somebody typed "ask whether the
 * sample reached" about this particular customer; that is more urgent than
 * anything on a general list.
 */
export function checklistForLead(
  settings: DiscoveryChecklistSettings | undefined,
  lead: { buyerType?: string; discoveryExtras?: DiscoveryFact[] } | undefined,
  businessType?: string,
): DiscoveryFact[] {
  const decided = Boolean(settings?.decidedAt);
  const spine = decided ? settings?.spine || [] : proposedDiscoveryChecklist(businessType);
  const segment = decided ? settings?.segments?.[normaliseSegmentKey(lead?.buyerType)] || [] : [];
  const extras = lead?.discoveryExtras || [];

  const seen = new Set<string>();
  const merged: DiscoveryFact[] = [];
  const take = (facts: DiscoveryFact[], base: number) => {
    for (const fact of facts) {
      if (!fact?.key || seen.has(fact.key)) continue;
      seen.add(fact.key);
      merged.push({ ...fact, priority: base + (fact.priority || 0) });
    }
  };
  take(extras, -1000);
  take(spine, 0);
  take(segment, 100);
  return merged.sort((a, b) => a.priority - b.priority);
}
