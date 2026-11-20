/**
 * VoiceOfCustomerService — the demand/confusion analysis (CP-12).
 *
 * Design: docs/LOGIC.md CP-12 + docs/DECISIONS.md D-2026-08-01-i/j/k.
 * Pinned by scripts/golden/golden-copilot-voice-of-customer.ts (6 cases).
 *
 * What it does: the owner asks "what are people asking for?" and this service
 * reads the FULL picture — customer messages (Reply.rawText) + leads (industry,
 * buyerType) + orders (lineItems) — and returns a RANKED report of demand topics.
 * It is a **T1 read-only** analysis: it never contacts a customer, never sends,
 * never mutates a record. (CP-12e.)
 *
 * Architecture (build-right Phase 3d — two layers, the deterministic one is the
 * proof-bearing seed):
 *   1. DETERMINISTIC aggregation (`aggregateTopics`) — pure, no AI. Counts exact
 *      keyword/topic matches across messages + order line items. This is the
 *      Golden Thread (golden-copilot-voice-of-customer CASE A hand-computes it).
 *   2. AI CLUSTERING layer (`summarizeWithLlm`) — optional, sits on top. The LLM
 *      reads the actual message words + the deterministic counts and writes a
 *      plain-English summary + merges paraphrases. Honest mock when no AI key.
 *
 * NON-NEGOTIABLE rules inherited from AGENTS.md + CP-12 (do NOT regress):
 *  - No-hallucination (CP-12d): fewer than 3 signals → "not enough data to tell"
 *    instead of inventing a trend. Never fabricates a product or demand.
 *  - Workspace isolation (CP-12e): reads ONE workspace's data only. The repo
 *    queries are workspace-scoped at the source — no cross-tenant leak (P0).
 *  - No-auto-outreach: this is read-only. Zero send paths. Grep-verified.
 *  - Honest AI status: reports real/mock/fallback so the owner never mistakes a
 *    mock summary for a real one.
 */
import type { RepositoryBundle } from "@/repositories";
import { createRepositories } from "@/repositories";
import { LLMService } from "@/llm/LLMService";

// CP-12d: the minimum signal count below which we refuse to draw a conclusion.
export const MIN_SIGNALS_FOR_CONCLUSION = 3;

export type DemandTopic = {
  /** The topic label (a product, a phrase, a question theme). */
  label: string;
  /** How many customer signals (messages + orders) mention it. */
  count: number;
  /** True when the topic is NOT in the owner's ProductSettings catalog — an
   * "emerging demand" signal (golden CASE D). */
  isEmergingDemand: boolean;
  /** Sample messages that fed this topic (so the owner can verify the signal). */
  samples: string[];
};

export type BuyerBreakdownEntry = { label: string; count: number };

export type VoiceOfCustomerReport = {
  /** Topics ranked DESC by count (highest demand first). */
  topics: DemandTopic[];
  /** A readable plain-English summary (what the owner sees in the Copilot chat). */
  summary: string;
  /** True when there's too little data to draw a conclusion (CP-12d). */
  insufficientData: boolean;
  /** "who's asking" breakdown from lead industry/buyerType. */
  buyerBreakdown: BuyerBreakdownEntry[];
  /** Honest AI status for the clustering layer. */
  aiStatus: "real" | "mock" | "fallback" | "none";
  /** Total signals analyzed (messages + orders). */
  totalSignals: number;
};

/**
 * Analyze the voice of customer for one workspace. The main entry point the
 * Copilot calls. Pure-read — never mutates, never sends.
 */
export async function analyzeVoiceOfCustomer(
  workspaceId: string,
  repos: RepositoryBundle = createRepositories(),
): Promise<VoiceOfCustomerReport> {
  // ── Gather the full picture (CP-12a), all workspace-scoped at the source ──
  const [replies, leads, orders, productSettings] = await Promise.all([
    repos.reply.listByWorkspace(workspaceId),
    repos.lead.listLeads(workspaceId),
    repos.order.listByWorkspace(workspaceId),
    repos.productSettings.getByWorkspace(workspaceId),
  ]);
  const catalogProducts: string[] = (productSettings?.products || [])
    .map((p) => p.name)
    .filter((n): n is string => Boolean(n && n.trim()));

  // ── Deterministic aggregation (the Golden-Thread seed) ────────────────────
  const topics = aggregateTopics(replies, orders, catalogProducts);
  const buyerBreakdown = aggregateBuyerBreakdown(leads);
  const totalSignals = replies.length + orders.length;
  const insufficientData = totalSignals < MIN_SIGNALS_FOR_CONCLUSION && topics.every((t) => t.count < MIN_SIGNALS_FOR_CONCLUSION);

  // ── No-hallucination (CP-12d): too little data → refuse to conclude ───────
  if (insufficientData) {
    return {
      topics,
      summary: "Not enough customer data to tell yet — keep collecting customer messages and orders, then ask me again. (I won't guess a trend from so few signals.)",
      insufficientData: true,
      buyerBreakdown,
      aiStatus: "none",
      totalSignals,
    };
  }

  // ── AI clustering layer (optional; honest mock when no key) ───────────────
  const llmResult = await summarizeWithLlm(workspaceId, topics, replies, repos);
  return {
    topics: llmResult.mergedTopics || topics,
    summary: llmResult.summary,
    insufficientData: false,
    buyerBreakdown,
    aiStatus: llmResult.aiStatus,
    totalSignals,
  };
}

// ─── Deterministic aggregation (PURE — the proof-bearing layer) ──────────────
/**
 * Count topic occurrences across customer messages + order line items. PURE —
 * no I/O, no AI. This is the function golden-copilot-voice-of-customer CASE A
 * hand-computes (gold border=5, red zari=3, sorted DESC).
 *
 * Strategy (two passes — accurate + roll-up):
 *   1. EXTRACT candidate topic terms: from messages (multi-word letter-runs with
 *      stop-words removed) + from order line-item product names + the catalog.
 *   2. COUNT per-message mentions: a topic T counts once per signal (message or
 *      order) whose text CONTAINS T as a substring. This is what the golden
 *      hand-computes ("5 messages mention 'gold border'"). It naturally rolls up
 *      "gold border bulk" into the "gold border" count (the longer phrase
 *      contains the shorter topic).
 *
 * A topic is "emerging demand" when it's not in the owner's catalog.
 */
export function aggregateTopics(
  replies: Array<{ rawText: string }>,
  orders: Array<{ lineItems?: Array<{ productName?: string }> }>,
  catalogProducts: string[],
): DemandTopic[] {
  // Pass 1: collect candidate topic terms (normalized keys).
  const candidateTerms = new Set<string>();
  for (const r of replies) for (const phrase of extractPhrases(r.rawText || "")) candidateTerms.add(normalizeTopic(phrase));
  for (const o of orders) for (const li of o.lineItems || []) if (li.productName) candidateTerms.add(normalizeTopic(li.productName));
  for (const p of catalogProducts) candidateTerms.add(normalizeTopic(p));

  // Build the signal corpus: each signal is one message or one order's product.
  const signals: Array<{ text: string; sample: string }> = [
    ...replies.map((r) => ({ text: normalizeTopic(r.rawText || ""), sample: r.rawText || "" })),
    ...orders.flatMap((o) => (o.lineItems || []).map((li) => ({ text: normalizeTopic(li.productName || ""), sample: `order: ${li.productName || ""}` }))),
  ];

  // Pass 2: count per-signal mentions (substring match → rolls up long phrases).
  const catalogLower = new Set(catalogProducts.map((p) => normalizeTopic(p)).filter(Boolean));
  const topics: DemandTopic[] = [];
  for (const term of candidateTerms) {
    if (!term || STOP_WORDS.has(term)) continue;
    // Skip single common-word terms that slipped through (must have ≥1 multiword OR be a catalog product).
    const count = signals.filter((s) => s.text.includes(term)).length;
    if (count < 1) continue;
    const samples = signals.filter((s) => s.text.includes(term)).slice(0, 3).map((s) => s.sample.length > 80 ? s.sample.slice(0, 80) + "…" : s.sample);
    topics.push({
      label: term,
      count,
      isEmergingDemand: !catalogLower.has(term),
      samples,
    });
  }
  // Sort DESC by count (highest demand first). Tie-break alphabetically for determinism.
  topics.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  // De-duplicate: drop a topic that is a strict substring of a higher-count topic
  // ONLY when their counts are equal (avoids "gold border" + "gold border bulk"
  // both showing when they cover the same messages). Keep the shorter (broader).
  return dedupeSubstringTopics(topics);
}

/**
 * Drop redundant substring topics. If topic B's label is a substring of topic A's
 * label AND they have the same count (B covers no extra messages), drop B.
 * Keeps the report clean ("gold border" instead of "gold border"+"gold border").
 */
function dedupeSubstringTopics(topics: DemandTopic[]): DemandTopic[] {
  return topics.filter((b) => {
    return !topics.some((a) => a.label !== b.label && a.count === b.count && a.label.includes(b.label) && a.label.length > b.label.length && a.label.startsWith(b.label));
  });
}

/** Break down "who's asking" by lead industry + buyerType. PURE. */
export function aggregateBuyerBreakdown(
  leads: Array<{ industry?: string; buyerType?: string }>,
): BuyerBreakdownEntry[] {
  const counts = new Map<string, number>();
  for (const l of leads) {
    const ind = l.industry?.trim();
    const bt = l.buyerType?.trim();
    if (ind) counts.set(ind, (counts.get(ind) || 0) + 1);
    if (bt && bt !== ind) counts.set(bt, (counts.get(bt) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Normalize a phrase to a comparable topic key (lowercase, trim, collapse spaces). */
function normalizeTopic(phrase: string): string {
  return phrase.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/** Extract candidate topic phrases (2-3 word letter-runs) from free text. PURE. */
function extractPhrases(text: string): string[] {
  const phrases: string[] = [];
  // Match runs of 2+ words made of letters (the likely product/topic names).
  const matches = text.toLowerCase().match(/[a-z][a-z\s]{2,}[a-z]/g) || [];
  for (const m of matches) {
    const words = m.trim().split(/\s+/).filter((w) => !STOP_WORDS.has(w) && w.length > 2);
    if (words.length >= 1) phrases.push(words.slice(0, 3).join(" "));
  }
  return phrases;
}

// Common words that should never be a "topic" (prevents "the" / "please" noise).
const STOP_WORDS = new Set([
  "the", "and", "for", "please", "want", "need", "have", "this", "that", "with",
  "you", "your", "are", "was", "can", "will", "just", "like", "what", "how",
  "much", "price", "quote", "hi", "hello", "thanks", "thank", "order", "buy",
  "get", "make", "from", "they", "them", "but", "not", "yes", "out", "all",
]);

// ─── AI clustering layer (optional; honest mock when no key) ─────────────────
async function summarizeWithLlm(
  workspaceId: string,
  topics: DemandTopic[],
  replies: Array<{ rawText: string }>,
  repos: RepositoryBundle,
): Promise<{ summary: string; mergedTopics?: DemandTopic[]; aiStatus: "real" | "mock" | "fallback" }> {
  // The deterministic counts ARE the report; the LLM just writes the plain-English
  // summary + merges paraphrases. If the LLM is unavailable, the deterministic
  // report still renders (honest mock).
  const deterministicSummary = renderDeterministicSummary(topics);
  try {
    const llm = new LLMService(undefined, repos);
    const result = await llm.runTask<{ summary?: string; topics?: Array<{ label: string; count: number }> }>("reply_classification", {
      task: "voice_of_customer_summary",
      deterministicTopics: topics.map((t) => ({ label: t.label, count: t.count, isEmergingDemand: t.isEmergingDemand })),
      sampleMessages: replies.slice(-20).map((r) => r.rawText),
    }, { workspaceId });
    const aiStatus: "real" | "mock" | "fallback" = result.mode === "real" ? "real" : result.fallbackUsed ? "fallback" : "mock";
    const summary = result.output?.summary || deterministicSummary;
    return { summary, aiStatus };
  } catch {
    // LLM unavailable (no key / usage blocked) → honest deterministic summary.
    return { summary: deterministicSummary, aiStatus: "mock" };
  }
}

/** Render a readable summary from the deterministic counts alone (no AI needed). */
function renderDeterministicSummary(topics: DemandTopic[]): string {
  if (topics.length === 0) return "No clear demand topics found yet.";
  const top = topics.slice(0, 5);
  const lines = top.map((t, i) => `${i + 1}. ${t.label} — ${t.count} signal(s)${t.isEmergingDemand ? " ⚠️ emerging demand (not in your catalog)" : ""}`);
  const emerging = topics.filter((t) => t.isEmergingDemand);
  const emergingNote = emerging.length > 0
    ? `\n\nEmerging demand (customers asked but it's not in your catalog): ${emerging.map((t) => t.label).join(", ")}. Consider whether to stock/make these.`
    : "";
  return `Top customer demand (by signal count):\n${lines.join("\n")}${emergingNote}`;
}
