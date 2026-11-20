/**
 * How a question the AI raised is shown to the owner (2026-09-29, owner
 * walk-through NY3/NY4/NY7). Pure, shared by "Needs you" and the answer path.
 */
import type { UnknownQuestion } from "@/lib/types";

/**
 * Knowledge sections that are the question bank's own catch-alls ("facts that
 * fit nowhere else"). A disagreement there is setup work for the Knowledge
 * screen, not something to interrupt the owner's day with.
 */
export const INTERNAL_KNOWLEDGE_SECTIONS = new Set(["extra_unmapped_information"]);

function sectionKey(domain?: string): string {
  return String(domain || "").trim().toLowerCase().replace(/\s+/g, "_");
}

export function isInternalSectionQuestion(q: Pick<UnknownQuestion, "relatedDomain" | "missingTopic">): boolean {
  return INTERNAL_KNOWLEDGE_SECTIONS.has(sectionKey(q.relatedDomain)) || INTERNAL_KNOWLEDGE_SECTIONS.has(sectionKey(q.missingTopic));
}

/** Disagreements about the SAME knowledge question share this key; others have none. */
export function sameQuestionKey(q: Pick<UnknownQuestion, "generatedBy" | "relatedDomain" | "relatedQuestionKey">): string | undefined {
  if (q.generatedBy !== "conflict_detection" || !q.relatedQuestionKey) return undefined;
  return `${sectionKey(q.relatedDomain)}::${q.relatedQuestionKey}`;
}

/** The question in the owner's words: no machine prefixes, no trade shorthand. */
export function plainQuestionTitle(text: string): string {
  let out = String(text || "").trim();
  const conflict = out.match(/^Conflicting information found for:\s*(.+?)\.?\s*Which answer is correct\?$/i);
  if (conflict) out = `Two answers disagree: ${conflict[1].trim()}`;
  const detail = out.match(/^A new source has more detail for:\s*(.+?)\.?\s*Should this update the approved answer\?$/i);
  if (detail) out = `New detail found: ${detail[1].trim()}`;
  out = out.replace(/\bMOQs\b/g, "minimum orders").replace(/\bMOQ\b/g, "minimum order");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** A "new source has more detail" question adds to an answer; it is not a disagreement (walk-through NY8). */
export function isNewDetailQuestion(text: string): boolean {
  return /^A new source has more detail for:/i.test(String(text || "").trim());
}
