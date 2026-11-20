import type { KnowledgeQuestionBatch } from "@/services/KnowledgeQuestionBatcher";
import { chunkByStructure, STRUCTURED_CHUNK_MAX_CHARS } from "@/rag/document-structure";

const domainKeywords: Record<string, string[]> = {
  product_knowledge: ["product", "material", "specification", "size", "color", "grade", "quality", "packing", "warranty", "moq"],
  product_varieties: ["variety", "model", "grade", "design", "color", "finish", "stock", "made-to-order", "moq", "sku"],
  product_applications: ["use", "application", "industry", "sector", "manufacturer", "buyer", "customer", "market", "deployment"],
  payment_credit_terms: ["payment", "advance", "credit", "gst", "invoice", "bank", "upi", "cheque", "quotation", "validity"],
  shipping_delivery: ["delivery", "dispatch", "transport", "courier", "shipping", "freight", "tracking", "delay"],
  returns_replacement: ["return", "replacement", "refund", "damage", "claim", "defect", "complaint", "cancellation"],
  whatsapp_communication: ["whatsapp", "reply", "message", "tone", "customer", "call", "escalation", "language"],
  pricing_policy: ["price", "pricing", "discount", "rate", "wholesale", "tax", "gst", "moq", "quote"],
  lead_qualification: ["lead", "buyer", "qualified", "bulk", "wholesale", "manufacturer", "retailer", "order", "requirement"],
};

/**
 * 2026-09-17 (session 56): delegates to the structure-aware chunker. The old
 * body cut at paragraph or sentence breaks with no idea what a table or a
 * section was, so a price row could reach the model without the column names
 * that say which quantity band each price belongs to. See
 * src/rag/document-structure.ts.
 */
export function splitDocumentIntoChunks(documentText: string, maxChunkLength = STRUCTURED_CHUNK_MAX_CHARS) {
  const chunks = chunkByStructure(documentText, maxChunkLength);
  return chunks.length ? chunks : [String(documentText || "").slice(0, maxChunkLength)];
}

/**
 * UA-4 root cause (2026-08-17, CEO-loop session 3, decision D6 "if any document
 * is contradicting always ask").
 *
 * Header prefixed to any chunk that relevance ranking did NOT select but which
 * states a measurement that disagrees with one already in the context. Without
 * the header the model treats the extra text as more of the same source and
 * quietly picks a winner; with it, the model is told the two are meant to be
 * compared. The wording deliberately forbids "pick the better one" — the
 * product rule is that a genuine disagreement always goes back to the owner.
 */
export const CONTRADICTION_CONTEXT_HEADER =
  "--- POSSIBLY CONFLICTING STATEMENTS FOUND ELSEWHERE IN THE SOURCE ---\n" +
  "The lines below come from a different part of the source material and appear to state a DIFFERENT figure for something covered above. Do not silently choose one. If they genuinely disagree, report it as a conflict so the business owner can decide.";

export function retrieveRelevantDocumentContext(documentText: string, batch: KnowledgeQuestionBatch, options: { maxChunks?: number; maxChars?: number; contradictionChunks?: number; contradictionChars?: number } = {}) {
  const chunks = splitDocumentIntoChunks(documentText);
  const keywords = buildKeywords(batch);
  const scored = chunks.map((chunk, index) => {
    const normalized = normalize(chunk);
    const score = keywords.reduce((total, keyword) => total + (normalized.includes(keyword) ? 1 : 0), 0);
    return { chunk, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const maxChunks = options.maxChunks || 5;
  // 6000, not 4500: chunks are now up to 1200 characters (whole sections and
  // whole table rows), and five of them must fit without the hard slice below
  // cutting the last one mid-row.
  const maxChars = options.maxChars || 6000;
  const selected = scored.filter((item) => item.score > 0).slice(0, maxChunks);
  const ranked = selected.length ? selected : scored.slice(0, Math.min(2, scored.length));
  // Whole chunks only. The first always goes in (truncated below if it alone is
  // over budget); after that a chunk that does not fit is skipped, not cut, so
  // the model never sees half a price row.
  const baseItems: typeof ranked = [];
  let used = 0;
  for (const item of ranked) {
    const cost = item.chunk.length + (baseItems.length ? 2 : 0);
    if (baseItems.length && used + cost > maxChars) continue;
    baseItems.push(item);
    used += cost;
  }
  const context = baseItems.map((item) => item.chunk).join("\n\n").slice(0, maxChars);

  // UA-4: relevance ranking alone can put two contradicting figures in two
  // different batches, so no single LLM call ever sees the disagreement. Sweep
  // the chunks this batch REJECTED for measurements that contradict one the
  // batch is about to reason over, and force those back in under a header.
  // Budget is deliberately small (2 chunks / 1500 chars) — this is a safety
  // net, not a second retrieval pass.
  const baseIndexes = new Set(baseItems.map((item) => item.index));
  const rejected = scored.filter((item) => !baseIndexes.has(item.index)).sort((a, b) => a.index - b.index).map((item) => item.chunk);
  const contradictions = findContradictionCandidates(context, rejected, {
    maxChunks: options.contradictionChunks ?? 2,
    maxChars: options.contradictionChars ?? 1500,
  });
  const contextText = contradictions.length
    ? `${context}\n\n${CONTRADICTION_CONTEXT_HEADER}\n${contradictions.join("\n\n")}`
    : context;

  return {
    contextText,
    chunksUsed: baseItems.length,
    hadRelevantContext: selected.length > 0,
    keywords,
    contradictionChunksUsed: contradictions.length,
  };
}

/**
 * Units this sweep understands, longest spelling first so `mm` never matches as
 * `m`. Only units where a differing number is a real business disagreement —
 * weights, lengths, percentages, lead times, pack sizes.
 */
const UNIT_ALIASES: Array<[RegExp, string]> = [
  [/^(kgs?|kilograms?|kilos?)$/, "kg"],
  [/^(gms?|grams?)$/, "g"],
  [/^(mm|millimet(er|re)s?)$/, "mm"],
  [/^(cms?|centimet(er|re)s?)$/, "cm"],
  [/^(m|met(er|re)s?)$/, "m"],
  [/^%$/, "%"],
  [/^(days?)$/, "day"],
  [/^(weeks?)$/, "week"],
  [/^(months?)$/, "month"],
  [/^(hrs?|hours?)$/, "hour"],
  [/^(pcs|pieces?|units?)$/, "piece"],
];

const MEASUREMENT_PATTERN = /(\d+(?:\.\d+)?)\s*(kilograms?|kilos?|kgs?|millimet(?:er|re)s?|centimet(?:er|re)s?|met(?:er|re)s?|grams?|gms?|hours?|months?|weeks?|days?|pieces?|units?|hrs?|pcs|mm|cm|kg|%|m)\b/gi;

/** Function words that carry no subject signal, so they can't earn an overlap point. */
const SIGNATURE_STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "will", "must", "then", "than", "when", "also", "been",
  "they", "them", "their", "there", "which", "while", "your", "ours", "into", "each", "only",
  "some", "more", "most", "other", "such", "because", "about", "after", "before", "between",
  "during", "under", "over", "same", "both", "very", "above", "below", "please", "note", "usually",
]);

type Measurement = { unit: string; value: number; signature: Set<string> };

function canonicalUnit(raw: string) {
  const lowered = raw.toLowerCase();
  for (const [pattern, unit] of UNIT_ALIASES) if (pattern.test(lowered)) return unit;
  return "";
}

/** Meaningful words within ±60 chars of a figure — what the figure is *about*. */
function signatureAround(text: string, at: number, length: number) {
  const window = text.slice(Math.max(0, at - 60), at + length + 60);
  return new Set(normalize(window).split(/\s+/).filter((word) => word.length >= 4 && !SIGNATURE_STOPWORDS.has(word) && !/^\d/.test(word)));
}

function extractMeasurements(text: string): Measurement[] {
  const out: Measurement[] = [];
  for (const match of text.matchAll(MEASUREMENT_PATTERN)) {
    const unit = canonicalUnit(match[2]);
    if (!unit) continue;
    out.push({ unit, value: Number(match[1]), signature: signatureAround(text, match.index ?? 0, match[0].length) });
  }
  return out;
}

function sharedWordCount(a: Set<string>, b: Set<string>) {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared;
}

/**
 * Return the rejected chunks that state a measurement contradicting one already
 * in `contextText`: same unit, different value, and at least 2 shared subject
 * words around the two figures.
 *
 * The 2-word threshold is the same one UA-3's `topicOverlapScore` settled on,
 * and for the same reason: a single shared word is routinely a coincidence
 * ("service" appearing in an unrelated sentence), two is not.
 *
 * This is a RECALL filter, not a verdict. A near-miss that isn't really a
 * contradiction (two sizes of the same product at two prices) costs a little
 * extra context and nothing else — the model still decides, and answers "no
 * conflict". A missed contradiction, by contrast, is silently wrong forever,
 * which is what UA-4 was. So the bias here is deliberately toward including.
 */
/**
 * Words that frame a measurement without identifying WHAT it measures.
 *
 * N-AI-3 (2026-08-18). `findContradictionCandidates` above is a RECALL filter
 * feeding extra context to a model, so an over-inclusive shared-word test costs
 * only tokens. `findMeasurementConflicts` below is a VERDICT: it raises an
 * owner-facing review item and flags live answers, so a false positive costs
 * the owner's attention — and a review queue full of non-conflicts is a queue
 * people stop reading.
 *
 * Measured need: the real MOQ answers are per-product LISTS, and every entry in
 * them ends "...has a minimum of N kg per shade". So "minimum" and "shade" are
 * shared by every pair of entries, and any two unrelated products clear a
 * plain 2-shared-word bar. Excluding the frame means the overlap has to come
 * from the SUBJECT — "zari"/"thread" — which is the thing that actually decides
 * whether two figures describe one fact.
 */
const MEASUREMENT_FRAME_WORDS = new Set([
  "minimum", "minimums", "maximum", "order", "orders", "quantity", "quantities",
  "shade", "shades", "design", "designs", "piece", "pieces", "unit", "units",
  "roll", "rolls", "pack", "packs", "size", "sizes", "rule", "rules", "policy",
  "value", "values", "amount", "amounts", "total", "price", "prices", "rate", "rates",
]);

/**
 * Do these two texts state contradicting measurements about the SAME subject?
 *
 * Same canonical unit, different value, and at least `minSharedSubjectWords`
 * shared words that are neither stopwords nor measurement-frame words.
 *
 * Exists because `detectContradiction` (KnowledgeAnswerComparisonService) works
 * on whole-answer number sets, which is right for short single-fact answers and
 * structurally blind on list answers: it bails when the two answers share ANY
 * number, and again when either side has more than 3 numbers. The real MOQ
 * answers hit both bails — they share "2 kg" (sequins) and "10", and the
 * variety answer lists 5 figures — so a genuine 5 kg vs 10 kg disagreement on
 * zari thread was invisible to it. This compares figure-by-figure instead of
 * answer-by-answer.
 */
export function findMeasurementConflicts(textA: string, textB: string, options: { minSharedSubjectWords?: number } = {}) {
  const minShared = options.minSharedSubjectWords ?? 2;
  const a = measurementsBySegment(textA || "");
  const b = measurementsBySegment(textB || "");
  const conflicts: Array<{ unit: string; valueA: number; valueB: number; subject: string[] }> = [];
  const seen = new Set<string>();

  for (const left of a) {
    for (const right of b) {
      if (left.unit !== right.unit) continue;
      if (left.value === right.value) continue;
      const subject = sharedSubjectWords(left.signature, right.signature);
      if (subject.length < minShared) continue;

      // De-duplicate mirrored hits. Two list answers can produce both
      // "2 kg vs 25 kg" and "25 kg vs 2 kg" for the same subject when each side
      // states both figures; that is ONE disagreement, and reporting it twice
      // makes the review item read like two separate problems.
      const key = `${left.unit}|${[left.value, right.value].sort((x, y) => x - y).join("-")}|${[...subject].sort().join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({ unit: left.unit, valueA: left.value, valueB: right.value, subject });
    }
  }
  return conflicts;
}

/**
 * Extract measurements with each figure's signature scoped to ITS OWN list entry.
 *
 * Why this is not just `extractMeasurements`: the signature is the words within
 * ±60 chars of a figure, and in a per-product list that window runs straight
 * past the end of the entry into the next product. Measured on the live answer
 * "...cutdana and beads have a minimum of 2 kg per shade; custom job work has a
 * minimum of 25 kg...", the window around "2 kg" swallowed "custom job work",
 * so a 2 kg figure and a 25 kg figure matched on the subject words of a product
 * neither of them was about. That produced a reported conflict between two
 * BYTE-IDENTICAL answers — a self-evidently wrong verdict.
 *
 * Splitting on entry boundaries (semicolon, newline, sentence end) confines each
 * figure to the product it belongs to. `findContradictionCandidates` keeps using
 * the unsegmented form: it is a recall filter, and bleeding into a neighbour
 * only widens what it offers the model.
 */
function measurementsBySegment(text: string): Measurement[] {
  const out: Measurement[] = [];
  for (const segment of text.split(/[;\n]+|\.\s+/)) {
    if (!segment.trim()) continue;
    out.push(...extractMeasurements(segment));
  }
  return out;
}

function sharedSubjectWords(a: Set<string>, b: Set<string>) {
  const shared: string[] = [];
  for (const word of a) if (b.has(word) && !MEASUREMENT_FRAME_WORDS.has(word)) shared.push(word);
  return shared;
}

export function findContradictionCandidates(contextText: string, rejectedChunks: string[], options: { maxChunks?: number; maxChars?: number } = {}) {
  const maxChunks = options.maxChunks ?? 2;
  const maxChars = options.maxChars ?? 1500;
  if (maxChunks <= 0 || maxChars <= 0) return [];
  const contextMeasurements = extractMeasurements(contextText);
  if (!contextMeasurements.length) return [];

  const picked: string[] = [];
  let used = 0;
  for (const chunk of rejectedChunks) {
    if (picked.length >= maxChunks || used >= maxChars) break;
    const conflicts = extractMeasurements(chunk).some((candidate) => contextMeasurements.some((known) =>
      known.unit === candidate.unit
      && known.value !== candidate.value
      && sharedWordCount(known.signature, candidate.signature) >= 2));
    if (!conflicts) continue;
    const trimmed = chunk.slice(0, maxChars - used);
    if (!trimmed) break;
    picked.push(trimmed);
    used += trimmed.length;
  }
  return picked;
}

function buildKeywords(batch: KnowledgeQuestionBatch) {
  const text = [
    batch.domainKey.replaceAll("_", " "),
    batch.domainTitle,
    ...(domainKeywords[batch.domainKey] || []),
    ...batch.questions.map((question) => question.question),
  ].join(" ");
  return Array.from(new Set(normalize(text).split(/\s+/).filter((word) => word.length > 3))).slice(0, 40);
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}%:+./\s-]/gu, " ").replace(/\s+/g, " ").trim();
}
