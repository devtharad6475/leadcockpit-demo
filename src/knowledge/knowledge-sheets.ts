/**
 * knowledge-sheets.ts — N13 (2026-09-25). Which questions a business is asked.
 *
 * The question pool (knowledge-question-framework.ts) holds every question any
 * checklist can contain. A workspace's CHECKLIST is the part of the pool that
 * applies to its kind of business. Everything that used to walk all 424
 * questions — extraction, the missing-answer list, the questions sent to the
 * owner, the quality score — walks the checklist instead.
 *
 * Where the kind comes from, in order:
 *   1. what the owner confirmed (stored on the business profile),
 *   2. otherwise a PROPOSAL from what is already known: the profile's business
 *      type and industry, and the answer to "Is the company a manufacturer,
 *      trader…?". A proposal is shown as "Suggested" until confirmed.
 *   3. If nothing is known, the checklist is the questions every business
 *      answers, and "what kind of business are you" is among them. Nothing is
 *      guessed: a wrong guess would ask a consultant about pallets.
 */
import {
  BUSINESS_KINDS,
  KNOWLEDGE_QUESTION_FRAMEWORK,
  type BusinessKind,
  type KnowledgeDomain,
  type KnowledgeQuestion,
  type KnowledgeQuestionWithDomain,
} from "./knowledge-question-framework";

export type ChecklistChoice = {
  kinds: BusinessKind[];
  exports: boolean;
  /** confirmed by the owner, proposed from known facts, or nothing known yet. */
  source: "confirmed" | "proposed" | "unknown";
};

const GOODS_KINDS: BusinessKind[] = ["manufacturer", "trader", "retailer"];

export function questionApplies(question: Pick<KnowledgeQuestion, "appliesTo">, choice: Pick<ChecklistChoice, "kinds" | "exports">): boolean {
  const { kinds, exportsOnly } = question.appliesTo;
  if (exportsOnly && !choice.exports) return false;
  if (kinds === "all") return true;
  const wanted = kinds === "goods" ? GOODS_KINDS : kinds;
  return choice.kinds.some((kind) => wanted.includes(kind));
}

/** The checklist as sections, empty sections dropped. */
export function checklistFramework(choice: Pick<ChecklistChoice, "kinds" | "exports">): KnowledgeDomain[] {
  return KNOWLEDGE_QUESTION_FRAMEWORK
    .map((domain) => ({ ...domain, questions: domain.questions.filter((question) => questionApplies(question, choice)) }))
    .filter((domain) => domain.questions.length > 0);
}

export function checklistQuestions(choice: Pick<ChecklistChoice, "kinds" | "exports">): KnowledgeQuestionWithDomain[] {
  return checklistFramework(choice).flatMap((domain) =>
    domain.questions.map((question) => ({ ...question, domainKey: domain.domainKey, domainTitle: domain.domainTitle })),
  );
}

/** "domainKey/questionKey" for every question on the checklist. */
export function checklistKeySet(choice: Pick<ChecklistChoice, "kinds" | "exports">): Set<string> {
  return new Set(checklistQuestions(choice).map((question) => `${question.domainKey}/${question.questionKey}`));
}

/**
 * Read kinds out of free text ("Mixed (manufacturer and trader)", "Textile
 * trims / zari manufacturing", "Wholesale distributor"). Word stems only; no
 * guessing from anything else.
 */
export function kindsFromText(text: string | undefined): { kinds: BusinessKind[]; exports: boolean } {
  const lower = (text || "").toLowerCase();
  const kinds = new Set<BusinessKind>();
  if (/\bmixed\b/.test(lower)) { kinds.add("manufacturer"); kinds.add("trader"); }
  if (/manufactur|\bmaker\b|\bfactory\b|\bproducer\b|\bmill\b/.test(lower)) kinds.add("manufacturer");
  if (/\btrader\b|\btrading\b|wholesal|distribut|stockist|reseller|\bdealer\b/.test(lower)) kinds.add("trader");
  if (/retail|\bshop\b|\bstore\b|boutique|showroom/.test(lower)) kinds.add("retailer");
  if (/service|consult|agency|\bstudio\b|contractor/.test(lower)) kinds.add("service");
  return { kinds: BUSINESS_KINDS.filter((kind) => kinds.has(kind)), exports: /export/.test(lower) };
}

export type ChecklistFacts = {
  /** What the owner confirmed, if anything. */
  confirmedKinds?: string[];
  confirmedExports?: boolean;
  confirmedAt?: string;
  /** Known facts a proposal can be read from. */
  businessType?: string;
  industry?: string;
  businessTypeAnswer?: string;
};

export function checklistChoiceFor(facts: ChecklistFacts): ChecklistChoice {
  if (facts.confirmedAt) {
    const kinds = BUSINESS_KINDS.filter((kind) => (facts.confirmedKinds || []).includes(kind));
    return { kinds, exports: Boolean(facts.confirmedExports), source: "confirmed" };
  }
  // The answer to the business-type question is the owner's own words about
  // this, so it wins over the profile's type and industry, which came from a
  // website scan.
  for (const text of [facts.businessTypeAnswer, facts.businessType, facts.industry]) {
    const read = kindsFromText(text);
    if (read.kinds.length) {
      const exports = [facts.businessTypeAnswer, facts.businessType, facts.industry].some((item) => kindsFromText(item).exports);
      return { kinds: read.kinds, exports, source: "proposed" };
    }
  }
  const exports = [facts.businessTypeAnswer, facts.businessType, facts.industry].some((item) => kindsFromText(item).exports);
  return { kinds: [], exports, source: exports ? "proposed" : "unknown" };
}

type ProfileLike = { businessType?: string; industry?: string; checklistKinds?: string[]; checklistExports?: boolean; checklistConfirmedAt?: string };
type AnswerLike = { workspaceId: string; domainKey: string; questionKey: string; answer?: string; answerStatus?: string };

/** Build the facts from what is stored: the workspace's profile and its answers. */
export function checklistFactsFrom(profile: ProfileLike | undefined, answers: AnswerLike[] = [], workspaceId?: string): ChecklistFacts {
  const typeAnswer = answers.find((item) =>
    (!workspaceId || item.workspaceId === workspaceId) &&
    item.domainKey === "company_knowledge" && item.questionKey === "business_type" &&
    item.answer?.trim() && item.answerStatus !== "unanswered");
  return {
    confirmedKinds: profile?.checklistKinds,
    confirmedExports: profile?.checklistExports,
    confirmedAt: profile?.checklistConfirmedAt,
    businessType: profile?.businessType,
    industry: profile?.industry,
    businessTypeAnswer: typeAnswer?.answer,
  };
}

const KIND_LABEL: Record<BusinessKind, string> = {
  manufacturer: "Manufacturer",
  trader: "Trader",
  retailer: "Retailer",
  service: "Service provider",
};

/** "Manufacturer + Trader · exports" — for screens. */
export function describeChecklist(choice: Pick<ChecklistChoice, "kinds" | "exports">): string {
  const kinds = choice.kinds.map((kind) => KIND_LABEL[kind]).join(" + ") || "Kind of business not set";
  return choice.exports ? `${kinds} · exports` : kinds;
}
