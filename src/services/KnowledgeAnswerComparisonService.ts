import type { KnowledgeQuestionAnswer, KnowledgeQuestionAnswerStatus } from "@/lib/types";

export type KnowledgeAnswerComparison =
  | "empty"
  | "equivalent"
  | "incoming_more_specific"
  | "existing_better"
  | "contradiction"
  | "different";

/**
 * 2026-09-27 (K5, break test): this used ASCII `\w`, so an answer in Hindi or
 * Gujarati normalised to "" — re-reading the SAME Hindi document raised a
 * false "conflicting information" card, and two different Gujarati answers
 * could not be told apart. Letters, digits and combining marks (the vowel
 * signs of Indic scripts) of every script are kept now.
 */
export function normalizeAnswerText(text = "") {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\s.%/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function areAnswersEquivalent(answerA = "", answerB = "") {
  const a = normalizeAnswerText(answerA);
  const b = normalizeAnswerText(answerB);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  return shorter.length > 24 && longer.includes(shorter);
}

export function isAnswerMoreSpecific(existing = "", incoming = "") {
  const existingText = normalizeAnswerText(existing);
  const incomingText = normalizeAnswerText(incoming);
  if (!incomingText) return false;
  if (!existingText) return true;
  const incomingSignals = specificitySignals(incomingText);
  const existingSignals = specificitySignals(existingText);
  return incomingText.length > existingText.length * 1.25 || incomingSignals > existingSignals;
}

export function detectContradiction(existing = "", incoming = "", questionText = "") {
  const a = normalizeAnswerText(existing);
  const b = normalizeAnswerText(incoming);
  const q = normalizeAnswerText(questionText);
  if (!a || !b) return false;
  if (areAnswersEquivalent(a, b)) return false;

  if (hasReturnConflict(a, b, q)) return true;
  if (hasPaymentConflict(a, b, q)) return true;
  if (hasNumericTermConflict(a, b, q)) return true;
  if (isBinaryQuestion(q) && hasYesNoConflict(a, b)) return true;
  return false;
}

export function compareKnowledgeAnswer(existing: KnowledgeQuestionAnswer | undefined, incoming: Pick<KnowledgeQuestionAnswer, "answer" | "answerStatus" | "question">): KnowledgeAnswerComparison {
  if (!incoming.answer?.trim() || incoming.answerStatus === "unanswered") return "empty";
  if (!existing?.answer?.trim() || existing.answerStatus === "unanswered") return "incoming_more_specific";
  if (detectContradiction(existing.answer, incoming.answer, incoming.question)) return "contradiction";
  if (areAnswersEquivalent(existing.answer, incoming.answer)) return "equivalent";
  if (isAnswerMoreSpecific(existing.answer, incoming.answer)) return "incoming_more_specific";
  if (isAnswerMoreSpecific(incoming.answer, existing.answer)) return "existing_better";
  return "different";
}

export function answerStatusRank(status: KnowledgeQuestionAnswerStatus, hasAnswer: boolean) {
  if (!hasAnswer && status !== "conflict") return 0;
  if (status === "unanswered") return 0;
  if (status === "not_applicable") return 1;
  if (status === "conflict") return 2;
  if (status === "partial") return 3;
  if (status === "needs_review") return 4;
  if (status === "answered") return 5;
  return 0;
}

// UA-3 fix: "existing_better" trusts length/specificity alone, so a long
// off-topic answer (e.g. a customer-service SLA paragraph) can permanently
// block a short, correct, on-topic answer from ever being flagged. This
// scores how many meaningful (4+ letter, non-stopword) words an answer
// shares with the question — used to catch the specific case where the
// "better" (longer) answer shares zero topic words with its own question.
const TOPIC_STOPWORDS = new Set(["the", "is", "are", "a", "an", "of", "to", "and", "or", "in", "on", "for", "with", "that", "this", "what", "which", "who", "how", "does", "do", "you", "your", "our", "company", "business"]);

export function topicOverlapScore(question = "", answer = "") {
  const questionWords = new Set(normalizeAnswerText(question).split(" ").filter((word) => word.length >= 4 && !TOPIC_STOPWORDS.has(word)));
  const answerWords = new Set(normalizeAnswerText(answer).split(" ").filter((word) => word.length >= 4 && !TOPIC_STOPWORDS.has(word)));
  let score = 0;
  for (const word of questionWords) if (answerWords.has(word)) score += 1;
  return score;
}

function specificitySignals(text: string) {
  let score = 0;
  score += (text.match(/\d+/g) || []).length;
  score += (text.match(/%|kg|gm|gram|day|week|month|moq|gst|denier|d\b|inch|mm|cm|rs|inr/g) || []).length;
  score += text.split(",").length - 1;
  return score;
}

function hasYesNoConflict(a: string, b: string) {
  return (isNegative(a) && isPositive(b)) || (isPositive(a) && isNegative(b));
}

function hasReturnConflict(a: string, b: string, q: string) {
  if (!/(return|replacement|refund|damage|claim)/.test(`${a} ${b} ${q}`)) return false;
  return hasYesNoConflict(a, b);
}

function hasPaymentConflict(a: string, b: string, q: string) {
  if (!/(payment|credit|advance|due|invoice|gst)/.test(`${a} ${b} ${q}`)) return false;
  return hasYesNoConflict(a, b) || hasNumericTermConflict(a, b, q);
}

function hasNumericTermConflict(a: string, b: string, q: string) {
  if (!/(credit|payment|delivery|dispatch|return|replacement|moq|minimum|warranty|sample)/.test(`${a} ${b} ${q}`)) return false;
  const aNums = extractNumbers(a);
  const bNums = extractNumbers(b);
  if (!aNums.length || !bNums.length) return false;
  const shared = aNums.filter((num) => bNums.includes(num));
  if (shared.length) return false;
  return aNums.length <= 3 && bNums.length <= 3;
}

function extractNumbers(text: string) {
  return Array.from(new Set((text.match(/\d+(?:\.\d+)?/g) || []).map((item) => Number(item))));
}

function isNegative(text: string) {
  return /\b(no|not|never|without|unavailable|not allowed|not accepted|cannot|can't|do not|does not)\b/.test(text);
}

function isPositive(text: string) {
  return /\b(yes|allowed|accepted|available|can|will|we do|provided|offered|eligible|within)\b/.test(text);
}

function isBinaryQuestion(text: string) {
  return /\b(does|do|is|are|can|will|should|allowed|available|eligible)\b/.test(text) && text.length < 180;
}
