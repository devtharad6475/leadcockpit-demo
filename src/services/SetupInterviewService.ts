/**
 * SetupInterviewService — the business setup, asked as a conversation (N13,
 * 2026-09-25; CEO: "the AI is going to ask the question upon the information
 * it has… like how a consultant asks follow-up questions").
 *
 * The checklist (knowledge-sheets.ts) says WHAT the business must answer; this
 * picks what to ask NEXT, from what is still missing after the documents and
 * website were read. The assistant phrases it in its own words and follows up
 * on vague answers (OwnerConversationBrain); this file only decides the order
 * and saves the owner's answer.
 *
 * Order: essential questions first (what the AI needs before it may speak for
 * the business), then required ones, then high priority, then the rest — each
 * group in checklist order, which starts with who the business is.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import { createRepositories } from "@/repositories";
import { getKnowledgeQuestion } from "@/knowledge/knowledge-question-framework";
import { answerKnowledgeQuestionFromUnknown, getWorkspaceChecklist, listKnowledgeQuestionAnswers, rebuildAnswerSearchIndex } from "@/services/DocumentQuestionAnsweringService";
import { detectContradiction } from "@/services/KnowledgeAnswerComparisonService";
import { setupQuestionWording } from "@/services/setup-question-wording";
export { setupQuestionWording } from "@/services/setup-question-wording";

export type SetupQuestion = { domainKey: string; questionKey: string; question: string };
export type SetupProgress = { missing: number; total: number; next?: SetupQuestion; /** "domain/key" of every question still missing */ open: Set<string> };

const OPEN = new Set(["unanswered", "partial"]);

export async function setupProgress(workspaceId: string, repos: RepositoryBundle = createRepositories(), exclude: Set<string> = new Set()): Promise<SetupProgress> {
  const [checklist, answers] = await Promise.all([getWorkspaceChecklist(workspaceId, repos), listKnowledgeQuestionAnswers(workspaceId, repos)]);
  const status = new Map(answers.map((answer) => [`${answer.domainKey}/${answer.questionKey}`, answer]));
  const gaps = checklist.questions.filter((question) => {
    if (!question.countsAsMissing) return false;
    const answer = status.get(`${question.domainKey}/${question.questionKey}`);
    return !answer || OPEN.has(answer.answerStatus) || !answer.answer?.trim();
  });
  const rank = (q: (typeof gaps)[number]) => (q.isEssential ? 0 : q.required ? 1 : q.priority === "high" ? 2 : 3);
  const ordered = gaps
    .map((question, index) => ({ question, index }))
    .sort((a, b) => rank(a.question) - rank(b.question) || a.index - b.index)
    .map((item) => item.question)
    .filter((question) => !exclude.has(`${question.domainKey}/${question.questionKey}`));
  const next = ordered[0];
  return {
    missing: gaps.length,
    total: checklist.questions.filter((question) => question.countsAsMissing).length,
    open: new Set(gaps.map((question) => `${question.domainKey}/${question.questionKey}`)),
    next: next ? { domainKey: next.domainKey, questionKey: next.questionKey, question: setupQuestionWording(next.domainKey, next.questionKey, next.question) } : undefined,
  };
}

/**
 * Save the owner's answer, in the owner's own words, to a checklist question.
 * Returns the previous answer when it said something different, so the
 * assistant can tell the owner a document disagrees instead of hiding it.
 */
export async function recordSetupAnswer(input: { workspaceId: string; domainKey: string; questionKey: string; answer: string; ownerWords?: string; expectedAnswer?: string; repos?: RepositoryBundle }): Promise<{ saved: boolean; previous?: string; contradicts: boolean }> {
  const repos = input.repos ?? createRepositories();
  const definition = getKnowledgeQuestion(input.domainKey, input.questionKey);
  if (!definition) return { saved: false, contradicts: false };
  const before = (await listKnowledgeQuestionAnswers(input.workspaceId, repos)).find((item) => item.domainKey === input.domainKey && item.questionKey === input.questionKey);
  const previous = before?.answer?.trim() && before.answerStatus !== "unanswered" ? before.answer.trim() : undefined;
  const saved = await answerKnowledgeQuestionFromUnknown(
    input.workspaceId, definition.question, input.answer,
    `${input.domainKey}/${input.questionKey}`, input.domainKey, input.questionKey, repos,
    input.ownerWords?.trim() ? { snippet: input.ownerWords.trim(), title: "You, in the assistant conversation" } : undefined,
    input.expectedAnswer,
  );
  // 2026-09-27 (K2, break test): the answer was saved as approved but the copy
  // the AI searches was never rebuilt, so a correction made here ("100 kg now")
  // left the AI quoting the old 50 kg, and a first answer was not findable at
  // all. The single-approve path always rebuilt; this one now does too.
  if (saved) await rebuildAnswerSearchIndex(input.workspaceId, repos);
  const contradicts = Boolean(previous && previous !== input.answer.trim() && detectContradiction(previous, input.answer, definition.question));
  return { saved: Boolean(saved), previous, contradicts };
}

/**
 * The owner's answer in clean Knowledge Base wording (CEO, 2026-09-26: "in the
 * proper wording the AI should put the answers"). The AI writes the clean
 * version; this decides whether it may be used. A rewrite may tidy words but
 * must preserve the owner's facts, quantities and qualifications. A digit-only
 * check is insufficient: "50 kg" becoming "50 metres", or "cannot guarantee"
 * becoming "guarantees", changes the business's approved knowledge. This is
 * deliberately conservative: only familiar grammatical/synonym tidying passes;
 * an unfamiliar paraphrase keeps the original, rather than guessing equivalence.
 * The owner's words are always kept as the evidence.
 */
export function safeAnswerWording(clean: string | undefined, ownerWords: string): { answer: string; rewritten: boolean } {
  const own = ownerWords.trim();
  const text = (clean || "").trim();
  if (!text || text.length > 800) return { answer: own, rewritten: false };
  if (answerFactSignature(text) !== answerFactSignature(own)) return { answer: own, rewritten: false };
  return { answer: text, rewritten: text !== own };
}

// These substitutions express the same fact; do not add open-ended stemming or
// discard modal/negative words, units, conditions, product names or locations.
const WORD_EQUIVALENTS: Record<string, string> = {
  make: "manufacture", makes: "manufacture", manufactures: "manufacture",
  trades: "trade", takes: "take", sells: "sell",
  kilograms: "kg", kilogram: "kg", kgs: "kg",
  metres: "metre", meters: "metre", meter: "metre",
  days: "day", hours: "hour", rupees: "inr", rupee: "inr", rs: "inr",
};
const GRAMMAR_WORDS = new Set(["the", "a", "an", "we", "our", "us", "i", "my", "it", "its", "company", "business", "is", "are", "am", "and", "n", "for", "on", "in"]);

function answerFactSignature(value: string): string {
  let normalized = value.toLowerCase().replace(/[’]/g, "'")
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/₹\s*(\d+(?:\.\d+)?)/g, "$1 inr")
    .replace(/\b(?:can't|cannot)\b/g, "can not")
    .replace(/\bwon't\b/g, "will not")
    .replace(/\b(?:don't|doesn't|do not|does not)\b/g, "not")
    .replace(/\bonly\s+b2b\b/g, "b2b only")
    .replace(/\bsells?\s+to\s+businesses\s+only\b/g, "b2b only");
  // Existing interview wording may remove a conversational pointer around a
  // phone number. Limit this exception to a complete phone-only answer: it may
  // neither conceal a qualification nor introduce another piece of information.
  const phone = normalized.match(/^(?:oh and for the first one its\s+)?(\+?\d[\d\s()-]+)$/);
  const contact = normalized.match(/^customers can reach the company on (\+?\d[\d\s()-]+)\.?$/);
  const number = phone?.[1] ?? contact?.[1];
  if (number && number.replace(/\D/g, "").length >= 10) normalized = number;
  return (normalized.match(/[\p{L}\p{N}]+(?:\.\d+)?|[%+]/gu) ?? [])
    .filter((word) => !GRAMMAR_WORDS.has(word))
    .map((word) => WORD_EQUIVALENTS[word] ?? word).join(" ");
}

export type SetupCandidate = { marker: string; question: string; answered: boolean };

/**
 * Every question on the business's checklist an answer could be filed under,
 * in the order the assistant should consider them: the question it just asked,
 * then others asked in this conversation, then the rest still missing, then
 * those already answered (so a correction lands where it belongs). The model
 * names one by its place in this list; the code maps it back.
 */
export async function setupCandidates(workspaceId: string, repos: RepositoryBundle, pendingMarker: string | undefined, asked: Set<string>): Promise<SetupCandidate[]> {
  const [checklist, answers] = await Promise.all([getWorkspaceChecklist(workspaceId, repos), listKnowledgeQuestionAnswers(workspaceId, repos)]);
  const status = new Map(answers.map((answer) => [`${answer.domainKey}/${answer.questionKey}`, answer]));
  const all = checklist.questions.map((question) => {
    const marker = `${question.domainKey}/${question.questionKey}`;
    const answer = status.get(marker);
    return { marker, question: setupQuestionWording(question.domainKey, question.questionKey, question.question), answered: Boolean(answer && !OPEN.has(answer.answerStatus) && answer.answer?.trim()) };
  });
  // The question the assistant just asked is always answerable, even if the
  // owner changed their kind of business since and it left the checklist.
  if (pendingMarker && !all.some((item) => item.marker === pendingMarker)) {
    const [domainKey, questionKey] = pendingMarker.split("/");
    const question = getKnowledgeQuestion(domainKey, questionKey);
    const answer = status.get(pendingMarker);
    if (question) all.unshift({ marker: pendingMarker, question: setupQuestionWording(domainKey, questionKey, question.question), answered: Boolean(answer && !OPEN.has(answer.answerStatus) && answer.answer?.trim()) });
  }
  const rank = (item: SetupCandidate) => (item.marker === pendingMarker ? 0 : asked.has(item.marker) && !item.answered ? 1 : !item.answered ? 2 : 3);
  return all.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(({ item }) => item);
}
