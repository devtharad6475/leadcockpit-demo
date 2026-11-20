/**
 * chunk-authority.ts — who said it, and does it still stand?
 * (2026-09-18, session 57.)
 *
 * Two kinds of text can answer a customer's question, and they are not equal:
 *
 *   APPROVED  — an answer the owner reviewed and approved. This is a fact the
 *               business has signed off on.
 *   DOCUMENT  — a line lifted out of an uploaded PDF. Nobody has checked it.
 *
 * Until now only APPROVED text was in the knowledge base, so the distinction
 * did not arise. Uploaded documents are now searchable too, which is what makes
 * this file necessary: after the owner corrects a fact, the ORIGINAL line in
 * the PDF still exists and still matches the question. Without a rule, a
 * meaning-search can hand the model the outdated line and the customer is told
 * a price the owner has already corrected — confidently, and with no error
 * anywhere.
 *
 * Two rules:
 *
 *   1. A RETIRED chunk is unreachable. When the owner confirms that a document
 *      line is superseded, the chunk is marked and retrieval skips it entirely.
 *      The row stays: it is the evidence of what the uploaded file actually
 *      said, and if the correction was itself wrong, that is how anyone finds
 *      out. It is out of the index, not out of history.
 *
 *   2. Approved text wins ties. Ordering is still by relevance (see
 *      SemanticRetriever's fusion); authority only breaks a tie, so a document
 *      line that is genuinely the better match still ranks first — clearly
 *      labelled as unverified when it reaches the model.
 */
import type { KnowledgeBaseChunk } from "@/lib/types";

export type ChunkAuthority = "approved" | "document";

/** Sources whose text the owner has approved. */
// "unknown_question" is the owner's own answer to a question the AI asked
// (AISettingsService) — approved by definition. It was missing here, so Test
// my AI labelled the owner's answers "Not approved yet" (walk-through 2026-09-29).
const APPROVED_SOURCES = new Set(["knowledge_question_answers", "business_profile", "manual", "workspace_override", "unknown_question"]);

export type SupersededMark = {
  /** The answer whose correction replaced this line. */
  answerId: string;
  /** When the owner retired it (ISO). */
  at: string;
  /** The corrected text that replaced it, for the audit trail. */
  replacedBy?: string;
};

/** A chunk the owner has retired. Never returned by retrieval. */
export function isSuperseded(chunk: { metadata?: Record<string, unknown> } | undefined): boolean {
  const mark = chunk?.metadata?.supersededBy;
  return Boolean(mark && typeof mark === "object");
}

export function chunkAuthority(chunk: { metadata?: Record<string, unknown> } | undefined): ChunkAuthority {
  const meta = chunk?.metadata || {};
  if (meta.extractionUnverified === true) return "document";
  const source = typeof meta.source === "string" ? meta.source : "";
  return APPROVED_SOURCES.has(source) ? "approved" : "document";
}

/** Higher wins a tie. Deliberately only two levels: more would be a ranking model, not a rule. */
export function authorityRank(chunk: { metadata?: Record<string, unknown> } | undefined): number {
  return chunkAuthority(chunk) === "approved" ? 1 : 0;
}

/**
 * One line per piece of knowledge a reply read, for the owner's "Test my AI"
 * box (2026-09-28). Says where the line came from, the line itself, and
 * whether the owner has approved it — the same split the retriever and the
 * prompt use, so the screen cannot call a line approved that the AI treats
 * as unverified.
 */
export type KnowledgeUsedLine = { source: string; line: string; approved: boolean; score: number };

export function describeKnowledgeUsed(
  chunks: Array<{ chunkText?: string; documentTitle?: string; score?: number; metadata?: Record<string, unknown> }>,
  limit = 5,
): KnowledgeUsedLine[] {
  return chunks.slice(0, limit).map((chunk) => {
    const text = String(chunk.chunkText || "").replace(/\s+/g, " ").trim();
    return {
      source: chunk.documentTitle?.trim() || "Untitled knowledge",
      line: text.length > 180 ? `${text.slice(0, 177).trimEnd()}…` : text,
      approved: chunkAuthority(chunk) === "approved",
      score: typeof chunk.score === "number" ? Math.round(chunk.score * 100) / 100 : 0,
    };
  });
}

export function withoutSuperseded<T extends { metadata?: Record<string, unknown> }>(chunks: T[]): T[] {
  return chunks.filter((chunk) => !isSuperseded(chunk));
}

/** The mark written onto a retired chunk. */
export function supersededMetadata(chunk: KnowledgeBaseChunk, mark: SupersededMark): Record<string, unknown> {
  return { ...(chunk.metadata || {}), supersededBy: mark };
}
