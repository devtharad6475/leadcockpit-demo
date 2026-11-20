/**
 * golden-test-my-ai-and-coverage.ts — 2026-09-28. The Knowledge Base screen's
 * headline and its "Test my AI" box.
 *
 *   A — "AI can answer from N of M": N counts only answers the AI may serve
 *       (owner-approved, or written by the owner). Answers read from a
 *       document and not yet OK'd do not count; "not applicable" questions
 *       leave both sides.
 *   B — the knowledge lines the test shows: approved vs not follows the same
 *       rule the retriever uses (chunkAuthority), long lines are cut, a
 *       missing title is named.
 *   C — the test itself (the WhatsApp dry-run path): it reports the
 *       knowledge it read and whether a real message would go out by itself,
 *       and it saves no reply, no log and no question, and sends nothing.
 *   D — found on the way: the customer reminders list was unreachable
 *       (shadowed by GET /leads/:id); no lead sub-route may sit behind it.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-test-my-ai-and-coverage.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { aiAnswerCoverage, isAnswerServable } from "@/lib/knowledge-readiness";
import { describeKnowledgeUsed } from "@/rag/chunk-authority";
import { plainTestReasons } from "@/lib/test-my-ai-reasons";
import { chunkKnowledgeDocument, createKnowledgeDocument } from "@/services/KnowledgeBaseService";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

test("A — the headline counts approved answers only", async () => {
  const answers = [
    { domainKey: "a", answer: "We ship across India", answerStatus: "answered", isUserApproved: true, sourceType: "document" },
    { domainKey: "a", answer: "MOQ is 50 kg", answerStatus: "answered", isUserApproved: false, sourceType: "user_answer" },
    { domainKey: "a", answer: "Open 10 to 7", answerStatus: "answered", isUserApproved: false, sourceType: "manual_edit" },
    // Read from a brochure, never OK'd: the AI cannot use it, so it must not count.
    { domainKey: "b", answer: "Rs 400 per metre", answerStatus: "answered", isUserApproved: false, sourceType: "document" },
    { domainKey: "b", answer: "Maybe 7 days", answerStatus: "needs_review", isUserApproved: false, sourceType: "document" },
    { domainKey: "b", answer: "", answerStatus: "unanswered", sourceType: "framework" },
    // Approved but blank is not an answer.
    { domainKey: "c", answer: "   ", answerStatus: "answered", isUserApproved: true, sourceType: "document" },
    { domainKey: "c", answer: "", answerStatus: "not_applicable", sourceType: "framework" },
  ];
  const coverage = aiAnswerCoverage(answers);
  assert.equal(coverage.canAnswer, 3, "only the approved or owner-written answers count");
  assert.equal(coverage.of, 7, "not-applicable questions leave the total");
  assert.equal(coverage.canAnswer, answers.filter((a) => a.answerStatus !== "not_applicable" && isAnswerServable(a)).length, "the headline must use the same rule as the AI's searchable copy");
  assert.deepEqual(aiAnswerCoverage([]), { canAnswer: 0, of: 0 });
});

test("B — each line says where it came from and whether it is approved", async () => {
  const long = "Our minimum order is fifty kilograms per colour. ".repeat(8);
  const lines = describeKnowledgeUsed([
    { chunkText: "Q: Do you ship abroad?\nA: Yes, to the UAE.", documentTitle: "Approved answers", score: 0.8123, metadata: { source: "knowledge_question_answers" } },
    { chunkText: long, documentTitle: "Brochure 2026.pdf", score: 0.5, metadata: { source: "uploaded_document", extractionUnverified: true } },
    // An approved source that extraction marked unverified is NOT approved.
    { chunkText: "Rates on request", documentTitle: "  ", score: 0.4, metadata: { source: "manual", extractionUnverified: true } },
    { chunkText: "Profile text", documentTitle: "Company profile", metadata: { source: "business_profile" } },
  ]);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => l.approved), [true, false, false, true]);
  assert.equal(lines[0].line, "Q: Do you ship abroad? A: Yes, to the UAE.", "whitespace folds to one line");
  assert.equal(lines[0].score, 0.81);
  assert.ok(lines[1].line.length <= 180 && lines[1].line.endsWith("…"), "a long line is cut to fit a phone");
  assert.equal(lines[2].source, "Untitled knowledge", "a blank title is named, not left empty");
  assert.equal(lines[3].score, 0);
  assert.equal(describeKnowledgeUsed(Array.from({ length: 9 }, () => ({ chunkText: "x" }))).length, 5, "at most five lines");
});

test("E — the owner's own answers are approved, and the 'why' is in plain words (walk-through 2026-09-29)", async () => {
  // The owner's answer to a question the AI asked is stored with source
  // "unknown_question". It was labelled "Not approved yet".
  const [ownerAnswer] = describeKnowledgeUsed([{ chunkText: "Q: Sample charges? A: Free up to 1 m", documentTitle: "Answer: Sample charges?", metadata: { documentType: "faq", source: "unknown_question" } }]);
  assert.equal(ownerAnswer.approved, true, "the owner's own answer must read as approved");
  const engineReason = "Could not verify do-not-contact registry status; held for review. The LLM reported missing knowledge about price.";
  const lines = plainTestReasons({ reason: engineReason, knowledgeUsed: [{ approved: true }, { approved: false }] });
  assert.ok(lines.some((l) => /document you have not approved/.test(l)), "leaning on an unapproved document must be said");
  assert.ok(lines.some((l) => /price, payment, delivery/.test(l)), "a sensitive topic must be said");
  assert.ok(lines.some((l) => /missing some facts/.test(l)), "missing facts must be said");
  assert.ok(lines.some((l) => /not one of your customers/.test(l)), "the unknown-number reason must be said");
  for (const l of lines) assert.ok(!/LLM|automation|registry|do-not-contact/i.test(l), `engine words leaked to the owner: ${l}`);
  assert.deepEqual(plainTestReasons({ reason: engineReason, sentByItself: true }), [], "nothing to explain when it would go out");
  assert.equal(plainTestReasons({ knowledgeUsed: [{ approved: true }] }).length, 1, "only the unknown-number reason when nothing else applies");
});

test("C — the test reports what it read and saves and sends nothing", async () => {
  const W = `ws_testmyai_${RUN}`;
  await ensureWorkspace(repos, W);
  const approved = await createKnowledgeDocument({ workspaceId: W, title: "Owner answers", documentType: "question_answers", source: "manual", contentText: "Dispatch city: we dispatch zari lace from Surat within five working days." }, repos);
  await chunkKnowledgeDocument(W, approved.id, repos, { embedFn: async () => { throw new Error("no embeddings in this golden"); } });
  const brochure = await createKnowledgeDocument({ workspaceId: W, title: "Old brochure", documentType: "other", source: "uploaded_document", contentText: "Zari lace dispatch from Surat takes ten days." }, repos);
  await chunkKnowledgeDocument(W, brochure.id, repos, { embedFn: async () => { throw new Error("no embeddings in this golden"); } });

  const logsBefore = (await repos.autoReplyLog.listByWorkspace(W)).length;
  const questionsBefore = (await repos.unknownQuestion.listByWorkspace(W)).length;

  const result = await handleIncomingWhatsAppMessage({ workspaceId: W, rawText: "How many days for zari lace dispatch from Surat?" }, repos, { dryRun: true });

  assert.equal(result.dryRun, true);
  assert.ok(Array.isArray(result.knowledgeUsed), "the test must say what knowledge it read");
  const used = result.knowledgeUsed || [];
  assert.ok(used.length >= 1, "the matching lines are reported");
  const bySource = new Map(used.map((line) => [line.source, line.approved]));
  if (bySource.has("Owner answers")) assert.equal(bySource.get("Owner answers"), true);
  if (bySource.has("Old brochure")) assert.equal(bySource.get("Old brochure"), false, "a brochure line is never shown as approved");
  assert.equal(typeof result.wouldHave?.sentByItself, "boolean", "the test says whether it would go out by itself");
  // No live AI in a golden: an unconfirmed model never sends by itself.
  assert.equal(result.wouldHave?.sentByItself, false);
  assert.equal(result.send.status === "sent", false, "nothing is sent");

  assert.equal((await repos.autoReplyLog.listByWorkspace(W)).length, logsBefore, "no reply log is saved");
  assert.equal((await repos.unknownQuestion.listByWorkspace(W)).length, questionsBefore, "no question is raised");
});

test("D — no GET /leads/:id/<something> route sits behind the catch-all GET /leads/:id", async () => {
  // Found 2026-09-28: the reminders list was registered after the catch-all,
  // so it returned the lead itself and opening any customer crashed the screen.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/app/api/[[...path]]/route.ts", "utf8");
  const getEnd = source.indexOf("export async function POST(");
  const getPart = source.slice(0, getEnd);
  const catchAll = getPart.indexOf('if (path[0] === "leads" && path[1]) return jsonOne(');
  assert.ok(catchAll > 0, "the catch-all GET /leads/:id moved — update this check");
  const shadowed = [...getPart.slice(catchAll).matchAll(/match\(path, \["leads", ":id", "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(shadowed, [], `these GET routes can never be reached: ${shadowed.join(", ")}`);
  assert.ok(getPart.slice(0, catchAll).includes('match(path, ["leads", ":id", "follow-ups"])'), "the reminders list must be served on GET");
});

async function main() {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
