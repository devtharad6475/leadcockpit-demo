/**
 * AgentInstructionConflictService.ts — N-AI-13 (2026-08-27).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * The owner can type anything into the Agent Instructions box and it is saved
 * without a single check. Two kinds of instruction are dangerous, and they fail
 * in opposite directions:
 *
 *   (1) An instruction that asks for something a LOCKED platform rule forbids —
 *       "reply to customers without asking me first", "message everyone on the
 *       list even if they opted out". These are typed in good faith by an owner
 *       who does not know the rule exists. The runtime already refuses to obey
 *       them: AgentRuntime injects the safety policies LAST so they win recency,
 *       under a heading that says they cannot be overridden. So the instruction
 *       is silently inert — the owner believes the AI is doing what they asked,
 *       and it is not. **A rule that silently ignores you is worse than a rule
 *       that argues with you.**
 *
 *   (2) An instruction that contradicts the workspace's OWN reviewed knowledge —
 *       "tell customers we ship worldwide" when the saved answer says the
 *       company does not export. Nothing compares the two, so the AI is handed
 *       both and the customer gets whichever one wins the toss.
 *
 * ── WHY THIS IS DETERMINISTIC AND NOT AN LLM CALL ───────────────────────────
 * Asking a model "do these contradict?" would cost tokens on every save, add
 * latency to a Save button, and produce a different answer on different days.
 * `detectContradiction` (KnowledgeAnswerComparisonService) is pure string logic
 * and already carries the topic gates and number-set comparison this needs — it
 * is the same detector the knowledge merge path and the fact-conflict path use.
 * Reusing it means this check costs nothing, runs on every save, and can be
 * pinned by a golden that needs no network and no key.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * It does not BLOCK the save, and it does not silently rewrite the owner's
 * words. Both would be worse than the defect: a block teaches the owner to
 * phrase around the checker, and a silent rewrite means the text on screen is
 * not the text in force. It reports, in the owner's own words, what will happen
 * and why — and the caller decides how loudly to say it.
 */
import { sanitizeWorkspaceOverride } from "@/lib/agent-guidance-safety";
import { detectContradiction, topicOverlapScore } from "@/services/KnowledgeAnswerComparisonService";
import type { KnowledgeQuestionAnswer } from "@/lib/types";

export type LockedRuleConflict = {
  kind: "locked_rule";
  /** Stable id, so a screen or a golden can name one without matching prose. */
  ruleId: string;
  /** The owner's own sentence that triggered this. */
  quotedInstruction: string;
  /** What the platform rule is, in the owner's language. */
  rule: string;
  /** What will actually happen when the AI runs. No hedging. */
  effect: string;
};

export type KnowledgeConflict = {
  kind: "knowledge";
  quotedInstruction: string;
  /** The saved question this instruction disagrees with. */
  question: string;
  /** The saved answer it disagrees with. */
  savedAnswer: string;
};

export type AgentInstructionCheck = {
  lockedRuleConflicts: LockedRuleConflict[];
  knowledgeConflicts: KnowledgeConflict[];
  /** True when the owner should be shown something before they walk away. */
  hasFindings: boolean;
};

/**
 * The locked rules an owner most plausibly tries to instruct their way around.
 *
 * Each pattern is written to match the way an OWNER would phrase it, not the
 * way an attacker would — prompt-injection phrasing is a different problem and
 * is already handled by `sanitizeWorkspaceOverride` in AgentRuntime. These are
 * honest business instructions that happen to be impossible.
 *
 * `effect` says what the system will really do. It is the load-bearing field:
 * the whole point of this service is that the owner finds out now rather than
 * from a customer.
 */
const LOCKED_RULES: Array<{ ruleId: string; test: RegExp; unless?: RegExp; rule: string; effect: string }> = [
  {
    ruleId: "auto_send_without_approval",
    // "reply without asking me", "send automatically", "no approval needed"
    test: /\b(?:(?:reply|respond|send|message)\w*\s+(?:to\s+\w+\s+)?(?:automatically|directly|without\s+(?:asking|approval|checking|my\s+permission|confirmation))|no\s+(?:approval|confirmation)\s+(?:is\s+)?(?:needed|required)|don'?t\s+ask\s+me\s+(?:first|before))\b/i,
    rule: "Every outbound message to a customer needs a person to approve it.",
    effect: "This line will not be followed. The approval step is part of the platform, not a setting, so messages will still wait for you.",
  },
  {
    ruleId: "contact_do_not_contact",
    test: /\b(?:contact|message|call|reach|email)\w*\s+(?:them|everyone|anyone|all)?\s*(?:even\s+if|regardless\s+of|despite)\s+(?:they\s+)?(?:opted?\s*-?\s*out|unsubscrib\w+|do\s*-?\s*not\s*-?\s*contact|dnc)\b|\bignore\s+(?:the\s+)?(?:do\s*-?\s*not\s*-?\s*contact|dnc|unsubscribe)\b/i,
    rule: "Do-not-contact is permanent. Once someone opts out they are never messaged again.",
    effect: "This line will not be followed, and it cannot be turned on. Opted-out customers stay excluded.",
  },
  {
    ruleId: "guess_missing_facts",
    // Second branch is deliberately tolerant of what sits between "know" and the
    // verb — an owner writes "if you don't know THE PRICE, just guess", and a
    // pattern that only allowed a comma there missed the most natural phrasing
    // of the most dangerous instruction on this list. Bounded to one sentence
    // by [^.!?] so it cannot reach across into an unrelated line.
    //
    // N-BUG (2026-09-08). Saved through the live Agent Instructions screen:
    //
    //   "If a customer asks something you do not know, make a reasonable
    //    guess so the conversation keeps moving. Never leave a question
    //    unanswered."
    //
    // and the owner was told nothing. Both branches missed it. The first wants
    // the verb before its object ("guess the price"), and here "guess" is a
    // noun — "make a reasonable guess" is how people write it. The second
    // wants the subject to be "you", and the owner wrote "if a customer asks
    // something you do not know", the same condition with the customer as the
    // subject. This is the most dangerous instruction on the list, typed the
    // way an owner actually types it, sailing through the one check that
    // exists for it.
    //
    // Third branch: "make/take/give a guess" as a noun phrase. Fourth: the
    // not-known condition with any subject. Fifth: "never leave a question
    // unanswered", which asks for the same behaviour without naming it.
    test: /\b(?:guess|estimate|make\s+up|invent|assume|fabricate)\s+(?:the\s+|a\s+|an\s+)?(?:price|prices|pricing|delivery|payment\s+terms?|answer|answers|details?|number|figure)\b|\b(?:make|take|give|use|provide|offer)\s+(?:a|an|your|the)\s+(?:reasonable|educated|rough|best|sensible|good)?\s*(?:guess|estimate)\b|\b(?:if|when|whenever|unless)\b[^.!?]*\b(?:don'?t|do\s+not|doesn'?t|does\s+not|not|aren'?t|isn'?t)\s+(?:know|sure|certain|available|there|in\s+the\s+knowledge)\b[^.!?]*\b(?:guess|estimate|assume|invent|say\s+something|make\s+something\s+up|fill\s+(?:it\s+)?in|improvise)\b|\bnever\s+leave\s+(?:a\s+|any\s+)?(?:question|message|customer|anything)\s+unanswered\b/i,
    // An owner who writes "never guess the price" is agreeing with the rule,
    // not fighting it, and warning them about their own compliance is how a
    // warning gets ignored. Deliberately narrow: it only excuses a negated
    // guess verb, so "never leave a question unanswered" — the same request
    // from the other direction — still reports.
    unless: /\b(?:never|do\s+not|don'?t|avoid|must\s+not|should\s+not)\s+(?:guess|estimate|make\s+up|invent|assume|fabricate)\b/i,
    rule: "The AI never invents a fact. Missing information is marked missing.",
    effect: "This line will not be followed. The AI will still say it does not know rather than guess a number.",
  },
  {
    ruleId: "skip_human_review",
    test: /\b(?:never|don'?t|do\s+not|no\s+need\s+to)\s+(?:escalate|ask\s+a\s+human|involve\s+(?:a\s+)?(?:human|person|staff)|send\s+(?:it\s+)?for\s+review)\b/i,
    rule: "Sensitive and uncertain conversations always go to a person.",
    effect: "This line will not be followed. Those conversations will still be handed to a person.",
  },
];

/** Split instruction text into sentences worth checking on their own. */
function instructionSentences(text: string): string[] {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
}

export function findLockedRuleConflicts(instructionText: string): LockedRuleConflict[] {
  const found: LockedRuleConflict[] = [];
  if (sanitizeWorkspaceOverride(instructionText) !== instructionText) found.push({
    kind: "locked_rule", ruleId: "override_evasion", quotedInstruction: instructionText.slice(0, 300),
    rule: "Additional guidance cannot override platform safety instructions or grant a new role.",
    effect: "Remove the request to bypass instructions. Your previous guidance stays in place.",
  });
  const seen = new Set<string>();
  for (const sentence of instructionSentences(instructionText)) {
    for (const rule of LOCKED_RULES) {
      // One finding per rule: an owner who says the same thing three ways has
      // one problem, not three, and three copies of the same warning is how a
      // warning gets ignored.
      if (seen.has(rule.ruleId)) continue;
      if (!rule.test.test(sentence)) continue;
      if (rule.unless?.test(sentence)) continue;
      seen.add(rule.ruleId);
      found.push({ kind: "locked_rule", ruleId: rule.ruleId, quotedInstruction: sentence, rule: rule.rule, effect: rule.effect });
    }
  }
  return found;
}

/**
 * Minimum shared topic words before an instruction sentence and a saved
 * question are considered to be about the same thing.
 *
 * Two, not one: one shared word is a coincidence ("delivery" appears in half
 * the sentences a textile business writes), and requiring three misses real
 * pairs. Deliberately paired with `detectContradiction`, which applies its own
 * topic gates on top — this number only decides which pairs are worth asking
 * about, never whether they disagree.
 */
const MIN_TOPIC_OVERLAP = 2;

export function findKnowledgeConflicts(instructionText: string, answers: KnowledgeQuestionAnswer[]): KnowledgeConflict[] {
  const found: KnowledgeConflict[] = [];
  const sentences = instructionSentences(instructionText);
  for (const answer of answers) {
    // Only answers the owner has actually settled. Comparing against an
    // unanswered or already-conflicted row would raise noise about a question
    // the owner has not resolved yet.
    if (answer.answerStatus !== "answered" || !answer.answer?.trim() || !answer.question?.trim()) continue;
    for (const sentence of sentences) {
      if (topicOverlapScore(answer.question, sentence) < MIN_TOPIC_OVERLAP) continue;
      if (!detectContradiction(answer.answer, sentence, answer.question)) continue;
      found.push({ kind: "knowledge", quotedInstruction: sentence, question: answer.question, savedAnswer: answer.answer });
      break; // one finding per saved answer
    }
  }
  return found;
}

export function checkAgentInstruction(instructionText: string, answers: KnowledgeQuestionAnswer[] = []): AgentInstructionCheck {
  const lockedRuleConflicts = findLockedRuleConflicts(instructionText);
  const knowledgeConflicts = findKnowledgeConflicts(instructionText, answers);
  return {
    lockedRuleConflicts,
    knowledgeConflicts,
    hasFindings: lockedRuleConflicts.length > 0 || knowledgeConflicts.length > 0,
  };
}
