/**
 * Why a "Test my AI" reply would wait for the owner — in the owner's words.
 * (2026-09-29, owner walk-through K2/K3.)
 *
 * The reply engine's own reason is written for engineers ("Cannot verify
 * do-not-contact status, so automation is blocked. The LLM reported missing
 * knowledge"). The owner needs to know three things instead: the test comes
 * from an unknown number, whether the draft leaned on a document they have
 * not approved, and whether the topic is one that always comes to them.
 * Pure, so the golden can pin every sentence.
 */
export type TestReasonInput = {
  reason?: string;
  sentByItself?: boolean;
  knowledgeUsed?: Array<{ approved: boolean }>;
};

const SENSITIVE = /\b(price|pricing|rate|discount|payment|credit|advance|delivery|dispatch|complaint|refund|return|legal|bulk)\b/i;
const MISSING = /missing (knowledge|facts?|information)|no (supporting|matching) (company )?knowledge|not (in|found in) (the )?knowledge/i;

export function plainTestReasons(input: TestReasonInput): string[] {
  if (input.sentByItself) return [];
  const out: string[] = [];
  if ((input.knowledgeUsed || []).some((line) => !line.approved)) {
    out.push("It read a line from a document you have not approved yet. A reply that leans on an unapproved document always waits for you.");
  }
  const reason = input.reason || "";
  if (SENSITIVE.test(reason)) out.push("It is about price, payment, delivery or a complaint. Those always come to you.");
  if (MISSING.test(reason)) out.push("The AI said it is missing some facts to answer fully. Approving the right answer below fixes that.");
  out.push("This test comes from a number that is not one of your customers, and a message from an unknown number always waits for you.");
  return out;
}
