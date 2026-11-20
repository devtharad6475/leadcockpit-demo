/**
 * load-fixture-knowledge.ts — N-DATA-1 step 3 of 3, and the proof for N-AI-1.
 *
 * WHAT PROBLEM THIS SOLVES
 * ------------------------
 * Step 2 (S3-15) rewrote the demo data so the product finally describes ONE
 * coherent fictional company. That was correct but it left the knowledge base
 * nearly empty: agentRuns 148 → 1, knowledgeExtractionSources 6 → 0,
 * knowledgeQuestionAnswers 4 → 0. Depth was traded for correctness.
 *
 * The wrong way to get the depth back is to hand-write plausible answers into
 * the JSON. That would restore the NUMBER while proving nothing — and it is how
 * the chimera data set got created in the first place.
 *
 * The right way is to feed the 18 practice documents in fixtures/meghdoot-zari/
 * through the SAME pipeline a real customer's upload goes through
 * (extractCompanyKnowledgeFromSourceBundle — the function POST
 * /api/onboarding/extract-company-knowledge calls), on the real model. Then the
 * depth is not asserted, it is produced, and the same run doubles as the live
 * end-to-end AI proof still owed on gate G6.
 *
 * THE MOCK GUARD (N-AI-2)
 * -----------------------
 * This script REFUSES to run if the daily_workhorse slot is on `mock`. That
 * refusal is the whole point: mock extraction returns canned answers, so
 * running it here would silently manufacture exactly the fake depth this step
 * exists to avoid — and it would look identical in the data afterwards.
 * `--allow-mock` exists only for testing the plumbing, and it stamps the receipt
 * so a mock run can never be mistaken for a real one.
 *
 * COST: real API calls, real money. Small — the pipeline batches one call per
 * knowledge domain, not one per question. Not a golden; never run in CI.
 *
 * SAFETY: this writes to the REAL .leadgen-data/app-data.json on purpose — the
 * restored depth is the deliverable. A timestamped backup is taken first and its
 * path is printed, so the previous state is always recoverable.
 *
 * Run:  npx tsx scripts/load-fixture-knowledge.ts
 *       npx tsx scripts/load-fixture-knowledge.ts --dry-run   (list sources, call nothing)
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const WORKSPACE_ID = "workspace_demo";
const FIXTURES = path.join(process.cwd(), "fixtures", "meghdoot-zari");
const DATA_FILE = path.join(process.cwd(), ".leadgen-data", "app-data.json");
const RECEIPTS = path.join(process.cwd(), "scripts", "probes", "_receipts");

const ALLOW_MOCK = process.argv.includes("--allow-mock");
const DRY_RUN = process.argv.includes("--dry-run");

/** README.md documents the fixture set for humans; it is not company knowledge. */
const NOT_KNOWLEDGE = new Set(["README.md"]);

/**
 * `--only=<substring>` loads a subset. This exists for the N-AI-3 experiment:
 * the merge service only compares an INCOMING answer against an EXISTING
 * canonical one, so a contradiction between two documents can only surface if
 * they arrive in separate runs. Loading fixture 18 on its own, after the full
 * set, is what proves that.
 */
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);

function fixtureFiles() {
  return readdirSync(FIXTURES)
    .filter((f) => !NOT_KNOWLEDGE.has(f))
    .filter((f) => !ONLY || f.includes(ONLY))
    .filter((f) => /\.(md|txt|csv)$/i.test(f))
    .sort()
    .map((fileName) => ({
      fileName,
      fileType: path.extname(fileName).slice(1).toLowerCase(),
      extractedText: readFileSync(path.join(FIXTURES, fileName), "utf8"),
      size: readFileSync(path.join(FIXTURES, fileName)).length,
    }));
}

// Imported dynamically INSIDE main(), not statically: loadEnvConfig() above must
// have already run before the repository singleton is constructed, and a static
// import would be hoisted ahead of it.
async function main() {
const { createRepositories } = await import("@/repositories");
const { extractCompanyKnowledgeFromSourceBundle } = await import("@/services/KnowledgeSourceBundleService");

const repos = createRepositories();
const files = fixtureFiles();

console.log(`sources: ${files.length} fixture documents, ${files.reduce((n, f) => n + f.extractedText.length, 0).toLocaleString()} characters total`);
for (const f of files) console.log(`  - ${f.fileName} (${f.extractedText.length.toLocaleString()} chars)`);

// ─── the N-AI-2 guard ────────────────────────────────────────────────────────
const routes = await repos.llmModelRouting.listByWorkspace(WORKSPACE_ID);
const workhorse = routes.find((r) => r.taskName === "daily_workhorse" && r.isEnabled);
const provider = workhorse?.provider || "(none — falls back to the mock default)";
console.log(`\ndaily_workhorse slot: ${provider}${workhorse?.modelName ? ` / ${workhorse.modelName}` : ""}`);
const isMock = !workhorse || workhorse.provider === "mock";
if (isMock && !ALLOW_MOCK) {
  console.error(
    `\nREFUSING TO RUN: the daily_workhorse slot is on mock, so this would write canned\n` +
      `answers into the demo knowledge base and they would be indistinguishable from real\n` +
      `ones afterwards. That is the exact defect N-DATA-1 exists to remove.\n\n` +
      `Fix: re-seed with a key present so the real routes are written —\n` +
      `  npm run seed:demo -- --force\n` +
      `(seed-demo writes DeepSeek slot rows only when PLATFORM_DEEPSEEK_API_KEY is set; see N-AI-2)\n\n` +
      `PLATFORM_DEEPSEEK_API_KEY is currently ${process.env.PLATFORM_DEEPSEEK_API_KEY?.trim() ? "SET" : "NOT SET"}.`,
  );
  process.exit(1);
}
if (isMock) console.warn("\n⚠ RUNNING ON MOCK (--allow-mock). The receipt will be stamped mock; this proves plumbing only.");

if (DRY_RUN) {
  console.log("\n--dry-run: no model called, nothing written.");
  process.exit(0);
}

// ─── backup before touching the real store ───────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${DATA_FILE}.bak-fixture-load-${stamp}`;
copyFileSync(DATA_FILE, backup);
console.log(`\nbackup: ${path.relative(process.cwd(), backup)}`);

function counts() {
  const d = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  const mine = (k: string) => (d[k] || []).filter((r: { workspaceId?: string }) => r.workspaceId === WORKSPACE_ID).length;
  return {
    knowledgeExtractionSources: mine("knowledgeExtractionSources"),
    knowledgeExtractionSourceBundles: mine("knowledgeExtractionSourceBundles"),
    knowledgeQuestionAnswers: mine("knowledgeQuestionAnswers"),
    knowledgeBaseDocuments: mine("knowledgeBaseDocuments"),
    knowledgeBaseChunks: mine("knowledgeBaseChunks"),
    agentRuns: mine("agentRuns"),
  };
}

const before = counts();
console.log(`before: ${JSON.stringify(before)}`);

const startedAt = Date.now();
console.log(`\nrunning extraction on ${provider}… (one model call per knowledge domain)`);

let result: Awaited<ReturnType<typeof extractCompanyKnowledgeFromSourceBundle>> | undefined;
let failure: string | undefined;
try {
  result = await extractCompanyKnowledgeFromSourceBundle({ workspaceId: WORKSPACE_ID, files }, repos);
} catch (e) {
  failure = e instanceof Error ? e.message : String(e);
}

const elapsedMs = Date.now() - startedAt;
const after = counts();

// ─── the contradiction check ─────────────────────────────────────────────────
// fixture 06 (pricing-and-moq-policy) and fixture 18 (misc-sales-notes) state
// DIFFERENT minimum order quantities on purpose. A pipeline that reports zero
// conflicts across this document set has not actually compared the sources — it
// has just taken whichever one it read last. So "conflicts found" is a PASS
// signal here, not a defect.
// NOTE: an earlier version of this counted `a.conflictCount`, which is not a
// field on KnowledgeQuestionAnswer — it silently reported 0 conflicts forever.
// The real signals are `answerStatus === "conflict"` / `conflictWithExisting`
// (set by markConflict in KnowledgeAnswerMergeService) and the review items
// raised alongside them with `generatedBy: "conflict_detection"`.
const data = JSON.parse(readFileSync(DATA_FILE, "utf8"));
const answers = (data.knowledgeQuestionAnswers || []).filter((a: { workspaceId?: string }) => a.workspaceId === WORKSPACE_ID);
const withConflicts = answers.filter(
  (a: { answerStatus?: string; conflictWithExisting?: boolean }) => a.answerStatus === "conflict" || a.conflictWithExisting === true,
);
const conflictReviewItems = (data.unknownQuestions || []).filter(
  (q: { workspaceId?: string; generatedBy?: string }) => q.workspaceId === WORKSPACE_ID && q.generatedBy === "conflict_detection",
);

const receipt = {
  script: "scripts/load-fixture-knowledge.ts",
  purpose: "N-DATA-1 step 3 (restore knowledge depth honestly) + N-AI-1 (real end-to-end extraction)",
  ranAt: new Date().toISOString(),
  elapsedMs,
  mode: isMock ? "MOCK (--allow-mock) — proves plumbing only" : "REAL",
  provider,
  modelName: workhorse?.modelName,
  sourceCount: files.length,
  sourceChars: files.reduce((n, f) => n + f.extractedText.length, 0),
  bundleStatus: result?.bundle?.status,
  runStatus: result?.questionAnswering?.run?.status,
  answersProduced: result?.questionAnswering?.answers?.length,
  routingResult: result?.routingResult,
  answersWithConflicts: withConflicts.length,
  conflictReviewItems: conflictReviewItems.length,
  conflictSample: withConflicts.slice(0, 5).map((a: { questionKey?: string; conflictReason?: string }) => ({ questionKey: a.questionKey, conflictReason: a.conflictReason })),
  before,
  after,
  failure,
  backup: path.relative(process.cwd(), backup),
};

if (!existsSync(RECEIPTS)) mkdirSync(RECEIPTS, { recursive: true });
const receiptPath = path.join(RECEIPTS, `fixture-knowledge-load-${stamp}.json`);
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

console.log(`\nafter:  ${JSON.stringify(after)}`);
console.log(`bundle: ${receipt.bundleStatus}   run: ${receipt.runStatus}   answers: ${receipt.answersProduced}   elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
console.log(`answers marked conflict: ${withConflicts.length}   conflict review items raised: ${conflictReviewItems.length}`);
console.log(`receipt: ${path.relative(process.cwd(), receiptPath)}`);
if (failure) {
  console.error(`\nFAILED: ${failure}`);
  console.error(`restore with: copy "${backup}" "${DATA_FILE}"`);
  process.exit(1);
}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
