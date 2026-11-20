/**
 * knowledge-readiness.ts — which answers the AI may use, in ONE place (K7,
 * 2026-09-27).
 *
 * The Knowledge Base screen's "Ready for the AI — used when the AI replies"
 * tile counted a section as ready once every question in it was ANSWERED. But
 * the AI serves only answers the owner has OK'd (the searchable copy is built
 * from isAnswerServable below). A section full of answers read from a
 * brochure and never approved showed as "Ready for the AI" while the AI could
 * use none of it. The server's rule and the screen's count now read the same
 * function, so they cannot drift apart again.
 *
 * Pure and dependency-free: imported by the server (the searchable-copy
 * rebuild) and by the browser (the Knowledge Base screen).
 */

export type ReadinessAnswer = {
  domainKey: string;
  answer?: string;
  answerStatus: string;
  isUserApproved?: boolean;
  sourceType?: string;
};

/** Is this answer one the AI is allowed to serve? */
export function isAnswerServable(item: Pick<ReadinessAnswer, "answer" | "answerStatus" | "isUserApproved" | "sourceType">): boolean {
  return (
    item.answerStatus === "answered" &&
    Boolean(item.answer?.trim()) &&
    Boolean(item.isUserApproved || item.sourceType === "user_answer" || item.sourceType === "manual_edit")
  );
}

/** An answer with something written that the AI cannot use until the owner OKs it. */
export function isWaitingForOwnerOk(item: Pick<ReadinessAnswer, "answer" | "answerStatus" | "isUserApproved" | "sourceType">): boolean {
  return ["answered", "needs_review", "partial"].includes(item.answerStatus) && Boolean(item.answer?.trim()) && !isAnswerServable(item);
}

export type KnowledgeReadiness = {
  /** Sections whose every question the AI can use (or that do not apply). */
  readySections: number;
  sections: number;
  /** Answers written down that the AI cannot use until the owner OKs them. */
  waitingForOk: number;
};

/**
 * The Knowledge Base headline, "AI can answer from N of M" (2026-09-28).
 *
 * N counts only answers the AI may serve (isAnswerServable — approved by the
 * owner or written by them). M is every question that applies to this
 * business: a question marked "not applicable" is not one the AI could ever
 * answer, so it is left out of both sides rather than counted as a gap.
 */
export function aiAnswerCoverage(answers: ReadinessAnswer[]): { canAnswer: number; of: number } {
  const applicable = answers.filter((item) => item.answerStatus !== "not_applicable");
  return { canAnswer: applicable.filter(isAnswerServable).length, of: applicable.length };
}

export function knowledgeReadiness(answers: ReadinessAnswer[]): KnowledgeReadiness {
  const bySection = new Map<string, { total: number; usable: number; servable: number }>();
  let waitingForOk = 0;
  for (const item of answers) {
    const section = bySection.get(item.domainKey) || { total: 0, usable: 0, servable: 0 };
    section.total += 1;
    if (isAnswerServable(item)) {
      section.servable += 1;
      section.usable += 1;
    } else if (item.answerStatus === "not_applicable") {
      section.usable += 1;
    }
    if (isWaitingForOwnerOk(item)) waitingForOk += 1;
    bySection.set(item.domainKey, section);
  }
  const readySections = [...bySection.values()].filter((section) => section.servable > 0 && section.usable >= section.total).length;
  return { readySections, sections: bySection.size, waitingForOk };
}
