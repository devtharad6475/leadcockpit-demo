/**
 * golden-learned-rules.ts — the system proposes a fact the owner keeps
 * correcting the AI on (N5, 2026-09-23, session 58).
 *
 * ── THE GAP ─────────────────────────────────────────────────────────────────
 * Approving a draft overwrote the AI's text with the owner's. So when the owner
 * rewrote the delivery answer for the fourth time, nothing anywhere recorded
 * that the AI had been wrong four times, or what the owner kept saying instead.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * The system PROPOSES; the owner decides. A proposal is an ordinary card in the
 * owner's queue with the answer pre-filled. It is never a fact until saved.
 *
 *   CASE A — an edited approval keeps the AI's draft; an unedited one does not.
 *   CASE B — only a change of content is a correction, not a comma.
 *   CASE C — fewer than three corrections costs nothing.
 *   CASE D — three on one topic produce ONE proposal, in the owner's queue.
 *   CASE E — corrections on different topics do not add up.
 *   CASE F — polish-only edits never add up to a "pattern".
 *   CASE G — once looked at, the same corrections are never paid for again.
 *   CASE H — one open proposal per topic.
 *   CASE I — a model that finds no consistent fact creates nothing.
 *   CASE J — old corrections describe an old business.
 *   CASE K — a failure here never throws into an approval.
 *   CASE L — the "holding message sent" flag is stored at last.
 *   CASE M — checks that start together still make ONE proposal.
 *
 * Run: npx tsx scripts/golden/golden-learned-rules.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import {
  considerLearning,
  isRealCorrection,
  LEARN_AFTER_CORRECTIONS,
  CORRECTION_WINDOW_DAYS,
  type ProposalCall,
} from "@/services/LearnedRuleService";
import { approveAutoReplyLog } from "@/services/AutoReplyReviewService";
import type { RepositoryBundle } from "@/repositories/interfaces";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let seq = 0;
const freshWorkspace = () => `ws_n5_${Date.now()}_${seq++}`;

const AI = "Delivery usually takes some time depending on the order. Please let us know your city and we will confirm.";
const OWNER = (n: number) => `Hamara dispatch 5 working days me hota hai, Surat se. Order no ${n} ke liye bhi same rahega.`;

/** A corrected, approved reply — created directly, as the approval would leave it. */
async function correction(workspaceId: string, topic = "delivery_question", n = seq++, at?: string) {
  return repos.autoReplyLog.create(workspaceId, {
    channel: "manual",
    incomingMessage: `Delivery kitne din me hogi? (${n})`,
    classification: topic,
    generatedReply: OWNER(n),
    aiDraft: AI,
    ownerEdited: true,
    status: "approved",
    canAutoSend: false,
    needsHumanReview: false,
    ...(at ? { createdAt: at } : {}),
  });
}

function counting(found = true) {
  const calls: Array<Parameters<ProposalCall>[0]> = [];
  const propose: ProposalCall = async (pairs) => {
    calls.push(pairs);
    return found
      ? { found: true, question: "Delivery kitne din me hoti hai?", answer: "Dispatch 5 working days me, Surat se." }
      : { found: false };
  };
  return { propose, calls };
}

test("CASE A — an edited approval keeps the AI's draft; an unedited one does not", async () => {
  const workspaceId = freshWorkspace();
  const draft = await repos.autoReplyLog.create(workspaceId, {
    channel: "manual", incomingMessage: "Delivery kitne din?", classification: "delivery_question",
    generatedReply: AI, status: "held_for_review", canAutoSend: false, needsHumanReview: true,
  });
  const approved = await approveAutoReplyLog(workspaceId, draft.id, { body: OWNER(1) }, repos);
  assert.strictEqual(approved.generatedReply, OWNER(1), "what was sent is what the owner wrote");
  assert.strictEqual(
    approved.aiDraft,
    AI,
    "THE GAP: the AI's version survives beside it. Before this, approval overwrote it and the correction — the " +
      "clearest statement of what the AI got wrong — was gone.",
  );
  assert.strictEqual(approved.ownerEdited, true);

  const untouched = await repos.autoReplyLog.create(workspaceId, {
    channel: "manual", incomingMessage: "Catalogue?", generatedReply: "Here is our catalogue.", status: "held_for_review",
    canAutoSend: false, needsHumanReview: true,
  });
  const same = await approveAutoReplyLog(workspaceId, untouched.id, { body: "Here is our   catalogue." }, repos);
  assert.ok(!same.ownerEdited, "extra spaces are not an edit");
  assert.ok(!same.aiDraft, "and nothing is kept when nothing changed");
});

test("CASE B — only a change of content is a correction, not a comma", async () => {
  assert.strictEqual(isRealCorrection(AI, AI.toUpperCase() + "!!"), false, "case and punctuation are not corrections");
  assert.strictEqual(isRealCorrection(AI, AI.replace("usually", "normally")), false, "one word in a long sentence is polish");
  assert.strictEqual(isRealCorrection(AI, OWNER(1)), true, "a different answer is a correction");
  assert.strictEqual(isRealCorrection(undefined, OWNER(1)), false, "no draft, nothing to compare");
});

test("CASE C — fewer than three corrections costs nothing", async () => {
  const workspaceId = freshWorkspace();
  for (let n = 0; n < LEARN_AFTER_CORRECTIONS - 1; n += 1) await correction(workspaceId);
  const { propose, calls } = counting();
  const result = await considerLearning(workspaceId, "delivery_question", repos, { propose });
  assert.strictEqual(result.reason, "not_enough_corrections");
  assert.strictEqual(calls.length, 0, "counting is free; asking a model is not, and two edits are not a pattern");
});

test("CASE D — three on one topic produce ONE proposal, in the owner's queue", async () => {
  const workspaceId = freshWorkspace();
  const made = [await correction(workspaceId), await correction(workspaceId), await correction(workspaceId)];
  const { propose, calls } = counting();
  const result = await considerLearning(workspaceId, "delivery_question", repos, { propose });

  assert.strictEqual(result.reason, "proposed");
  assert.strictEqual(calls.length, 1, "one model call");
  assert.ok(calls[0].every((pair) => pair.aiDraft === AI), "shown what the AI wrote");
  assert.ok(calls[0].some((pair) => pair.sent.includes("5 working days")), "and what the owner sent instead");

  const card = result.proposed!;
  assert.strictEqual(card.status, "open", "a PROPOSAL — not a fact until the owner saves it");
  assert.strictEqual(card.generatedBy, "learned_from_corrections");
  assert.strictEqual(card.suggestedAnswer, "Dispatch 5 working days me, Surat se.", "the answer is pre-filled for one-click saving");
  assert.notStrictEqual(card.channel, "whatsapp", "the queue must not say a customer asked this — the owner's edits did");
  assert.deepStrictEqual([...(card.sourceIds || [])].sort(), made.map((log) => log.id).sort(), "and it points at the corrections it came from");

  // Both places the AI reads company facts from. The system proposes; only the
  // owner's save may write either of them.
  const snapshot = await repos.readAll!();
  assert.strictEqual(
    (snapshot.knowledgeQuestionAnswers || []).filter((answer) => answer.workspaceId === workspaceId).length,
    0,
    "NOTHING was written to the knowledge answers by the system itself",
  );
  assert.strictEqual((await repos.knowledgeBaseDocument.listByWorkspace(workspaceId)).length, 0, "nor to the searchable documents");
});

test("CASE E — corrections on different topics do not add up", async () => {
  const workspaceId = freshWorkspace();
  await correction(workspaceId, "delivery_question");
  await correction(workspaceId, "price_request");
  await correction(workspaceId, "moq_question");
  const { propose, calls } = counting();
  const result = await considerLearning(workspaceId, "delivery_question", repos, { propose });
  assert.strictEqual(result.reason, "not_enough_corrections");
  assert.strictEqual(calls.length, 0, "one delivery, one price and one MOQ edit are three different stories, not a pattern");
});

test("CASE F — polish-only edits never add up to a pattern", async () => {
  const workspaceId = freshWorkspace();
  for (let n = 0; n < 4; n += 1) {
    await repos.autoReplyLog.create(workspaceId, {
      channel: "manual", incomingMessage: "?", classification: "delivery_question", status: "approved",
      aiDraft: AI, generatedReply: AI.replace("Please", "Kindly"), ownerEdited: true, canAutoSend: false, needsHumanReview: false,
    });
  }
  const { propose, calls } = counting();
  const result = await considerLearning(workspaceId, "delivery_question", repos, { propose });
  assert.strictEqual(result.reason, "not_enough_corrections");
  assert.strictEqual(calls.length, 0, "four owners' polishes are not four corrections — and must not interrupt anyone");
});

test("CASE G — once looked at, the same corrections are never paid for again", async () => {
  const workspaceId = freshWorkspace();
  for (let n = 0; n < 3; n += 1) await correction(workspaceId);
  const first = counting(false);
  await considerLearning(workspaceId, "delivery_question", repos, { propose: first.propose });
  assert.strictEqual(first.calls.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const again = counting(false);
  const second = await considerLearning(workspaceId, "delivery_question", repos, { propose: again.propose });
  assert.strictEqual(
    again.calls.length,
    0,
    "the next approval must not re-ask about the same three. Without the record, a topic whose edits are style " +
      "would cost a model call on every approval forever.",
  );
  assert.strictEqual(second.reason, "not_enough_corrections");

  for (let n = 0; n < 3; n += 1) await correction(workspaceId);
  const later = counting(false);
  await considerLearning(workspaceId, "delivery_question", repos, { propose: later.propose });
  assert.strictEqual(later.calls.length, 1, "three NEW corrections are worth one more look");
});

test("CASE H — one open proposal per topic", async () => {
  const workspaceId = freshWorkspace();
  for (let n = 0; n < 3; n += 1) await correction(workspaceId);
  await considerLearning(workspaceId, "delivery_question", repos, { propose: counting().propose });
  for (let n = 0; n < 3; n += 1) await correction(workspaceId);
  const { propose, calls } = counting();
  const result = await considerLearning(workspaceId, "delivery_question", repos, { propose });
  assert.strictEqual(result.reason, "already_proposed");
  assert.strictEqual(calls.length, 0);
  const open = (await repos.unknownQuestion.listByWorkspace(workspaceId, { status: "open" }))
    .filter((question) => question.generatedBy === "learned_from_corrections");
  assert.strictEqual(open.length, 1, "a second card saying the same thing splits the owner's answer across two places");
});

test("CASE I — a model that finds no consistent fact creates nothing", async () => {
  const workspaceId = freshWorkspace();
  for (let n = 0; n < 3; n += 1) await correction(workspaceId);
  const result = await considerLearning(workspaceId, "delivery_question", repos, { propose: counting(false).propose });
  assert.strictEqual(result.reason, "no_consistent_rule");
  const open = await repos.unknownQuestion.listByWorkspace(workspaceId, { status: "open" });
  assert.strictEqual(open.length, 0, "no fact, no card. A proposal built on nothing is worse than silence.");

  // A model that says "no pattern" and fills in a guess anyway. Its own verdict
  // wins: the first version of this case returned found:false with no text, so
  // a check that ignored `found` passed it (mutation M10).
  const hedged = freshWorkspace();
  for (let n = 0; n < 3; n += 1) await correction(hedged);
  const hedge = await considerLearning(hedged, "delivery_question", repos, {
    propose: async () => ({ found: false, question: "Delivery kitne din?", answer: "Shayad 5 din, pakka nahi." }),
  });
  assert.strictEqual(hedge.reason, "no_consistent_rule", "the model's own 'no' wins over the guess it attached");
  assert.strictEqual((await repos.unknownQuestion.listByWorkspace(hedged, { status: "open" })).length, 0);

  const halfEmpty = await considerLearning(freshWorkspace(), "x", repos, { propose: async () => ({ found: true, question: "", answer: "" }) });
  assert.notStrictEqual(halfEmpty.reason, "proposed");
});

test("CASE J — old corrections describe an old business", async () => {
  const workspaceId = freshWorkspace();
  const future = new Date(Date.now() + (CORRECTION_WINDOW_DAYS + 5) * 86_400_000);
  for (let n = 0; n < 3; n += 1) await correction(workspaceId);
  const { propose, calls } = counting();
  const result = await considerLearning(workspaceId, "delivery_question", repos, { propose, now: () => future });
  assert.strictEqual(result.reason, "not_enough_corrections");
  assert.strictEqual(calls.length, 0, `a correction older than ${CORRECTION_WINDOW_DAYS} days may describe terms that have since changed`);
});

test("CASE K — a failure here never throws into an approval", async () => {
  const workspaceId = freshWorkspace();
  for (let n = 0; n < 3; n += 1) await correction(workspaceId);
  const broken = new Proxy(repos as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "unknownQuestion") {
        return { ...(Reflect.get(target, prop, target) as object), listByWorkspace: async () => { throw new Error("queue unavailable"); } };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as RepositoryBundle;
  const result = await considerLearning(workspaceId, "delivery_question", broken, { propose: counting().propose });
  assert.strictEqual(result.reason, "failed", "reported, not thrown — the customer already has their reply");
});

test("CASE L — the 'holding message sent' flag is stored at last", async () => {
  // Passed by the WhatsApp engine since CP-22 and stored by NEITHER substrate:
  // both writers named their fields by hand and left it out. The owner's
  // timeline could never say a holding message had gone out.
  const workspaceId = freshWorkspace();
  const log = await repos.autoReplyLog.create(workspaceId, {
    channel: "whatsapp", incomingMessage: "price?", status: "acknowledged", acknowledgementSent: true,
    canAutoSend: false, needsHumanReview: true,
  });
  const reread = await repos.autoReplyLog.getById(workspaceId, log.id);
  assert.strictEqual(reread?.acknowledgementSent, true);
});

test("CASE M — checks that start together still make ONE proposal", async () => {
  // Found in the browser, not by a test. The check runs in the background after
  // each approval; three quick approvals finished before any check began, so
  // the checks ran side by side, each saw "three corrections, no card yet", and
  // the owner's queue got the same proposal twice — and paid for it twice.
  const workspaceId = freshWorkspace();
  for (let n = 0; n < 3; n += 1) await correction(workspaceId);
  const { propose, calls } = counting();
  const slowPropose: ProposalCall = async (pairs, topic) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return propose(pairs, topic);
  };
  await Promise.all([1, 2, 3].map(() => considerLearning(workspaceId, "delivery_question", repos, { propose: slowPropose })));
  const cards = (await repos.unknownQuestion.listByWorkspace(workspaceId, { status: "open" }))
    .filter((question) => question.generatedBy === "learned_from_corrections");
  assert.strictEqual(cards.length, 1, "one card, however many approvals raced");
  assert.strictEqual(calls.length, 1, "and one model call");
});

(async () => {
  console.log("\n=== GOLDEN: learned rules from the owner's corrections (N5) ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: learned-rules");
    process.exit(1);
  }
})();
