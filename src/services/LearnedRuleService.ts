/**
 * LearnedRuleService — propose a fact the owner keeps correcting the AI on
 * (N5, 2026-09-23, session 58).
 *
 * ── THE SAFE HALF OF "LEARNING" ─────────────────────────────────────────────
 * The system notices a pattern — the owner has rewritten the AI's reply about
 * delivery three times — and PROPOSES the fact those rewrites keep stating.
 * It does not learn it. The proposal lands in the owner's ordinary "Needs you"
 * queue, with the answer pre-filled, and becomes knowledge only when the owner
 * saves it there. Nothing new to audit, nothing that changes a reply on its own.
 *
 * The alternative — a hidden store of "rules the AI picked up" — is the one the
 * operator ruled out for the lead memory, for the same reason: a thing the AI
 * learned belongs where the owner can read it, correct it, or refuse it.
 *
 * ── WHAT COUNTS AS A CORRECTION ─────────────────────────────────────────────
 * Only a real change of content. Fixing a comma, or rewording the same sentence,
 * says nothing about what the business wants to be true, and three of those
 * must not add up to a "pattern" that costs a model call and interrupts the
 * owner with a proposal about punctuation.
 *
 * ── WHEN IT RUNS, AND WHAT IT COSTS ─────────────────────────────────────────
 * After an approval that changed the draft, never awaited. Counting is free.
 * A model is asked only when a topic has gathered THREE new corrections since
 * it was last looked at — and it is then recorded as looked at whatever the
 * answer, so a topic whose corrections turn out to be style costs one call per
 * three corrections, not one per approval forever.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AutoReplyLog, UnknownQuestion } from "@/lib/types";
import { createRepositories } from "@/repositories";
import { LLMService } from "@/llm/LLMService";

/** Corrections on one topic before the system proposes anything. */
export const LEARN_AFTER_CORRECTIONS = 3;
/** Older corrections describe a business that may have changed since. */
export const CORRECTION_WINDOW_DAYS = 90;
/** Pairs shown to the model — enough to see a pattern, bounded for cost. */
const MAX_PAIRS = 6;
export const LEARNING_CHECK_JOB = "learned_rule_check";

const normalise = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Did the owner change what the reply SAYS, or only how it reads?
 *
 * Word-set overlap, deliberately simple and free. Punctuation and case are
 * ignored; a rewrite that keeps nine words in ten is a polish, not a correction.
 */
export function isRealCorrection(aiDraft: string | undefined, sentText: string | undefined): boolean {
  const before = normalise(aiDraft || "");
  const after = normalise(sentText || "");
  if (!before || !after || before === after) return false;
  const a = new Set(before.split(" "));
  const b = new Set(after.split(" "));
  const shared = [...a].filter((word) => b.has(word)).length;
  const overlap = shared / new Set([...a, ...b]).size;
  return overlap < 0.9;
}

export type LearnedProposal = { found: boolean; question?: string; answer?: string };
export type ProposalCall = (pairs: Array<{ aiDraft: string; sent: string; customerAsked: string }>, topic: string) => Promise<LearnedProposal>;

export type LearningResult = {
  proposed?: UnknownQuestion;
  reason: "proposed" | "not_enough_corrections" | "already_proposed" | "no_consistent_rule" | "failed";
  corrections: number;
};

/**
 * Checks for the same topic, one at a time.
 *
 * Found in the browser: three approvals in quick succession each started a
 * check in the background, the checks ran side by side, each saw "three
 * corrections and no card yet", and the owner got the same proposal twice —
 * paid for twice. Queued per workspace and topic, the second check starts after
 * the first has written its card and its record, and finds nothing to do.
 *
 * In-process: correct for one server. With several, two could still race; the
 * cost of that is one duplicate card the owner can dismiss, not a wrong fact.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * Look at one topic's corrections and propose a fact if they agree.
 * Never throws: it runs after the owner's approval has already gone through.
 */
export function considerLearning(
  workspaceId: string,
  topic: string,
  repos: RepositoryBundle = createRepositories(),
  options: { propose?: ProposalCall; now?: () => Date } = {},
): Promise<LearningResult> {
  const queueKey = `${workspaceId}:${topic || "general"}`;
  const previous = queues.get(queueKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => considerLearningNow(workspaceId, topic, repos, options));
  queues.set(queueKey, run);
  void run.finally(() => {
    if (queues.get(queueKey) === run) queues.delete(queueKey);
  });
  return run;
}

async function considerLearningNow(
  workspaceId: string,
  topic: string,
  repos: RepositoryBundle,
  options: { propose?: ProposalCall; now?: () => Date },
): Promise<LearningResult> {
  try {
    const now = (options.now ?? (() => new Date()))();
    const since = new Date(now.getTime() - CORRECTION_WINDOW_DAYS * 86_400_000).toISOString();
    const key = topic || "general";

    // Corrections an earlier check of this topic already looked at. Only NEW
    // ones count, so the same three are never paid for twice.
    //
    // 2026-09-27 (A3): this used to be "updatedAt after the last check". But
    // updatedAt moves for reasons that are not a new correction — adding an
    // internal note to the thread bumps it — so noting three old corrections
    // sent the same three to the paid model again. Every check records the ids
    // it looked at in its payload; those ids are what is excluded now.
    const checked = new Set<string>();
    for (const job of await repos.jobRun.listByWorkspace(workspaceId)) {
      const payload = job.payload as { topic?: string; corrections?: unknown } | undefined;
      if (job.jobType !== LEARNING_CHECK_JOB || payload?.topic !== key || !Array.isArray(payload.corrections)) continue;
      for (const id of payload.corrections) if (typeof id === "string") checked.add(id);
    }
    // The saved card is also evidence that these corrections were handled.
    // If the later job receipt fails, dismissing the card must not pay for or
    // propose the same corrections again.
    const proposals = (await repos.unknownQuestion.listByWorkspace(workspaceId))
      .filter((question) => question.generatedBy === "learned_from_corrections" && question.missingTopic === key);
    for (const question of proposals) {
      for (const id of question.sourceIds || []) checked.add(id);
    }

    const corrections = (await repos.autoReplyLog.listByWorkspace(workspaceId, { status: "approved" }))
      .filter((log) => log.ownerEdited && (log.classification || "general") === key)
      .filter((log) => isRealCorrection(log.aiDraft, log.generatedReply))
      .filter((log) => log.updatedAt >= since && !checked.has(log.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    if (corrections.length < LEARN_AFTER_CORRECTIONS) {
      return { reason: "not_enough_corrections", corrections: corrections.length };
    }

    // One open proposal per topic. A second card saying the same thing is
    // noise, and it would split the owner's answer across two places.
    const open = proposals.find((question) => question.status === "open");
    if (open) return { reason: "already_proposed", corrections: corrections.length };

    const pairs = corrections.slice(0, MAX_PAIRS).map((log: AutoReplyLog) => ({
      aiDraft: String(log.aiDraft || ""),
      sent: String(log.generatedReply || ""),
      customerAsked: String(log.incomingMessage || "").slice(0, 400),
    }));
    const proposal = await (options.propose ?? defaultPropose(workspaceId, repos))(pairs, key);

    if (!proposal || typeof proposal.found !== "boolean") {
      throw new Error("The learning check did not return a usable answer.");
    }
    const question = typeof proposal.question === "string" ? proposal.question.trim().slice(0, 300) : "";
    const answer = typeof proposal.answer === "string" ? proposal.answer.trim().slice(0, 1200) : "";
    if (proposal.found && (!question || !answer)) {
      throw new Error("The learning check did not return a complete suggestion.");
    }
    const recordChecked = () => repos.jobRun.create({
      workspaceId,
      jobType: LEARNING_CHECK_JOB,
      status: "completed",
      payload: { topic: key, corrections: corrections.map((log) => log.id), found: Boolean(proposal?.found) } as never,
      attempts: 1,
      maxAttempts: 1,
    });

    if (!proposal.found) {
      // A valid negative result is complete; unavailable or malformed results
      // above remain retryable and never consume these corrections.
      await recordChecked();
      return { reason: "no_consistent_rule", corrections: corrections.length };
    }

    const proposed = await repos.unknownQuestion.create(workspaceId, {
      // Not "whatsapp": the queue says "a customer asked this on WhatsApp" for
      // that channel, and no customer asked this — the owner's edits did.
      channel: "owner_corrections",
      questionText: question,
      suggestedAnswer: answer,
      generatedBy: "learned_from_corrections",
      missingTopic: key,
      status: "open",
      priority: "medium",
      sourceIds: corrections.map((log) => log.id),
    });
    // Only a saved owner-facing card closes a positive learning check.
    await recordChecked();
    return { proposed, reason: "proposed", corrections: corrections.length };
  } catch (error) {
    console.warn(`[learned-rules] could not consider "${topic}": ${error instanceof Error ? error.message : String(error)}`);
    return { reason: "failed", corrections: 0 };
  }
}

function defaultPropose(workspaceId: string, repos: RepositoryBundle): ProposalCall {
  return async (pairs, topic) => {
    const prompt = `A B2B business owner has corrected an AI's WhatsApp replies about "${topic}" several times before sending them.

${pairs.map((pair, n) => `#${n + 1}
Customer asked: ${pair.customerAsked}
AI drafted: ${pair.aiDraft}
Owner sent instead: ${pair.sent}`).join("\n\n")}

Is there ONE fact or policy the owner keeps adding or fixing — a delivery time, a minimum order, a payment rule, a product detail — that the AI should have known?

RULES:
- Only a fact the owner's versions actually STATE, in their words. Never infer, never generalise beyond them.
- If the owner's versions disagree with each other, or the changes are only tone or wording, the answer is found:false.
- The question is what a customer would ask; the answer is what the owner's versions say.

Return JSON: {"found": true|false, "question": "<customer-style question>", "answer": "<the owner's fact>"}`;
    const result = await new LLMService(undefined, repos).runTask<LearnedProposal>(
      "knowledge_answer",
      { topic },
      { workspaceId, overridePrompt: prompt },
    );
    if (result.mode !== "real" || result.fallbackUsed) {
      throw new Error("The AI is unavailable; the learning check can be retried later.");
    }
    return result.output;
  };
}
