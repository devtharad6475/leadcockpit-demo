/**
 * N13 test 4 — "nothing gets worse" (CEO condition, 2026-09-18; $2 approved
 * 2026-09-25).
 *
 * The 18 Meghdoot fixture documents go through the product's real extraction
 * step twice, with the real AI: once asking the OLD 424 questions, once asking
 * the new Manufacturer + Trader checklist. Each run is graded against the
 * written answer key (docs/UI-AUDIT-2026-08/02-BUSINESS-GROUND-TRUTH.md).
 * If the checklist finds fewer facts, it does not ship.
 *
 * GRADING (free, deterministic, identical for both runs): a fact counts as
 * found when every key value in it — its **bold** terms, or failing that its
 * numbers — appears in that run's extracted answers. Facts with no key value
 * are not graded (listed as "not gradeable"). Lenient, but the same rule
 * scores both lists, which is what the comparison needs.
 *
 * COST GUARD: spend is estimated from text length (≈4 characters a token) at
 * the model's list price. After a one-batch model check, the script stops
 * before the full runs if the projection for both is over $1.80.
 *
 * Run: npx tsx scripts/probes/n13-test4-real-documents.ts
 * (isolated JSON data store — nothing touches the demo database.)
 */
import "../golden/_helpers/isolate-standalone";
import fs from "node:fs";
import path from "node:path";
import { createRepositories } from "@/repositories";
import { answerDocumentQuestions, listKnowledgeQuestionAnswers } from "@/services/DocumentQuestionAnsweringService";
import { checklistFramework, checklistQuestions } from "@/knowledge/knowledge-sheets";
import { KNOWLEDGE_QUESTION_FRAMEWORK as LEGACY } from "./legacy/legacy-424-framework";
import { createExtractionPlan } from "@/services/KnowledgeQuestionBatcher";
import { LLMService } from "@/llm/LLMService";

const CAP_USD = 1.8;
// USD per million tokens [input, output]. Unknown models use the dearest row.
const PRICES: Array<[RegExp, number, number]> = [
  [/deepseek/i, 0.27, 1.1],
  [/gemini.*flash/i, 0.3, 2.5],
  [/haiku/i, 1, 5],
  [/gpt-4o-mini|gpt-4\.1-mini|mini/i, 0.4, 1.6],
  [/sonnet|gpt-4o|gpt-4\.1|gemini.*pro/i, 3, 15],
];
const priceFor = (model: string) => PRICES.find(([pattern]) => pattern.test(model)) ?? [/./, 15, 75] as [RegExp, number, number];

const repos = createRepositories("json");
const root = process.cwd();
const docsDir = path.join(root, "fixtures/meghdoot-zari");
const files = fs.readdirSync(docsDir).filter((file) => file !== "README.md").sort();
const corpus = files.map((file) => `# Document: ${file}\n\n${fs.readFileSync(path.join(docsDir, file), "utf8")}`).join("\n\n---\n\n");

type Fact = { id: string; text: string; keys: string[] };
function answerKey(): Fact[] {
  const md = fs.readFileSync(path.join(root, "docs/UI-AUDIT-2026-08/02-BUSINESS-GROUND-TRUTH.md"), "utf8");
  const facts: Fact[] = [];
  for (const line of md.split("\n")) {
    const row = line.match(/^\|\s*(GT-[A-Z]+-\d+)\s*\|\s*(.+?)\s*\|\s*$/);
    if (!row) continue;
    const text = row[2];
    const bold = [...text.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]);
    const numbers = text.replace(/`[^`]*`/g, " ").match(/\d[\d,./]*\d|\d/g) || [];
    facts.push({ id: row[1], text, keys: (bold.length ? bold : numbers).map(norm).filter((key) => key.length > 0) });
  }
  return facts;
}
function norm(text: string) {
  return text.toLowerCase().replace(/[₹,]/g, "").replace(/[“”"'`]/g, "").replace(/\s+/g, " ").trim();
}

const legacyList = {
  framework: LEGACY as never,
  questions: (LEGACY as Array<{ domainKey: string; domainTitle: string; questions: Array<Record<string, unknown>> }>)
    .flatMap((domain) => domain.questions.map((question) => ({ ...question, domainKey: domain.domainKey, domainTitle: domain.domainTitle }))) as never,
};
const choice = { kinds: ["manufacturer", "trader"] as ("manufacturer" | "trader")[], exports: false, source: "confirmed" as const };
const checklistList = { framework: checklistFramework(choice), questions: checklistQuestions(choice) };

async function workspace(label: string) {
  const workspaceId = `ws_test4_${label}_${Date.now()}`;
  await repos.workspace.create({ id: workspaceId, name: `Test 4 ${label}`, status: "active" } as never);
  await repos.businessProfile.create({ workspaceId, companyName: "Meghdoot Zari", checklistKinds: ["manufacturer", "trader"], checklistExports: false, checklistConfirmedAt: new Date().toISOString() } as never);
  return workspaceId;
}

async function run(label: string, list: typeof checklistList) {
  const workspaceId = await workspace(label);
  const started = Date.now();
  const summary = await answerDocumentQuestions({ workspaceId, documentText: corpus, documentMetadata: { title: "Meghdoot Zari — 18 company documents", sourceType: "document" } }, repos, { questionList: list as never });
  const answers = (await listKnowledgeQuestionAnswers(workspaceId, repos)).filter((answer) => answer.answer?.trim() && answer.answerStatus !== "unanswered");
  const text = norm(answers.map((answer) => answer.answer).join("\n"));
  const facts = answerKey();
  const graded = facts.filter((fact) => fact.keys.length);
  const found = graded.filter((fact) => fact.keys.every((key) => text.includes(key)));
  return {
    label, seconds: Math.round((Date.now() - started) / 1000),
    questionsAsked: list.questions.length,
    answered: answers.length,
    conflicts: answers.filter((answer) => answer.answerStatus === "conflict").length,
    factsGraded: graded.length, factsFound: found.length,
    foundIds: new Set(found.map((fact) => fact.id)),
    notGradeable: facts.length - graded.length,
    outputChars: text.length,
    model: JSON.stringify((summary as unknown as { modelUsed?: unknown }).modelUsed ?? null),
  };
}

(async () => {
  console.log(`18 documents, ${corpus.length} characters. Answer key: ${answerKey().length} facts.`);
  // 1. Model check: one real call, what answers and at what price.
  const probe = await new LLMService(undefined, repos).runTask("document_extraction_mapping", { documentTitle: "model check", documentText: "Meghdoot Zari makes zari thread.", questionCount: 1 }, { workspaceId: await workspace("modelcheck") });
  const model = `${probe.provider}/${probe.modelName}`;
  if (probe.mode !== "real" || probe.fallbackUsed) { console.log(`STOP — no real AI answered (${model}, ${probe.mode}). Nothing measured.`); process.exit(2); }
  const [, inPrice, outPrice] = priceFor(model);
  const calls = createExtractionPlan(LEGACY as never).length + createExtractionPlan(checklistList.framework).length;
  const inputTokens = calls * (corpus.length + 12000) / 4;
  const outputTokens = calls * 4000;
  const projected = (inputTokens * inPrice + outputTokens * outPrice) / 1e6;
  console.log(`Model: ${model}. ${calls} calls for both runs. Projected spend ≈ $${projected.toFixed(2)} (cap $${CAP_USD}).`);
  if (projected > CAP_USD) { console.log("STOP — projection is over the cap. Nothing run."); process.exit(3); }

  // ONLY=checklist re-measures the checklist after a wording fix and compares
  // with the old list's count from the last full run (half the cost).
  if (process.env.ONLY === "checklist") {
    const previous = JSON.parse(fs.readFileSync(path.join(root, "scripts/probes/n13-test4-result.json"), "utf8"));
    const oldFound = previous.table.find((row: { label: string }) => row.label === "old-424").factsFound as number;
    const newRun = await run("checklist", checklistList);
    const { foundIds, ...row } = newRun;
    console.table([row]);
    const verdict = newRun.factsFound >= oldFound ? `PASS — checklist ${newRun.factsFound} vs old 424 ${oldFound} (from the last full run)` : `FAIL — checklist ${newRun.factsFound} vs old 424 ${oldFound}`;
    console.log(`Found: ${[...foundIds].join(", ")}`);
    console.log(verdict);
    fs.writeFileSync(path.join(root, "scripts/probes/n13-test4-result-checklist-only.json"), JSON.stringify({ at: new Date().toISOString(), model, row, foundIds: [...foundIds], comparedWithOld: oldFound, verdict }, null, 2));
    return;
  }

  // 2. Both runs, same text, separate workspaces.
  const oldRun = await run("old-424", legacyList as never);
  console.log(`old 424 done in ${oldRun.seconds}s`);
  const newRun = await run("checklist", checklistList);
  console.log(`checklist done in ${newRun.seconds}s`);

  const onlyOld = [...oldRun.foundIds].filter((id) => !newRun.foundIds.has(id));
  const onlyNew = [...newRun.foundIds].filter((id) => !oldRun.foundIds.has(id));
  const table = [oldRun, newRun].map(({ foundIds, ...row }) => ({ ...row, found: [...foundIds].join(" ") }));
  console.table(table);
  console.log(`Facts only the old 424 found (${onlyOld.length}): ${onlyOld.join(", ") || "none"}`);
  console.log(`Facts only the checklist found (${onlyNew.length}): ${onlyNew.join(", ") || "none"}`);
  const verdict = newRun.factsFound >= oldRun.factsFound ? "PASS — the checklist finds at least as many facts" : "FAIL — the checklist finds fewer facts; it does not ship";
  console.log(verdict);
  fs.writeFileSync(path.join(root, "scripts/probes/n13-test4-result.json"), JSON.stringify({ at: new Date().toISOString(), model, projectedUsd: projected, table, onlyOld, onlyNew, verdict }, null, 2));
})().catch((error) => { console.error(error); process.exit(1); });
